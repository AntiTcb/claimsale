import {
	encodeCsv,
	EXPORT_KINDS,
	exportExpiresAt,
	invoiceNumberLabel,
	itemsExport,
	ordersExport,
	shippingExport,
	tableRows,
	type ExportItem,
	type ExportKind,
	type InvoiceStatus,
	type Millis,
	type OrderSource,
	type ShippingAddress,
	type Table,
} from "@claimsale/core";
import { Clock, Data, Effect, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import type { EngineEnv } from "../env.ts";
import { toExisting, type ItemImportRow } from "../sale/import.ts";
import { rowsOf } from "../sale/rows.ts";
import { parseJson } from "../sale/settings.ts";

/**
 * Seller exports (PLAN §3c.2): the request writes an `io_jobs` row and its audit row,
 * then queues an `export_job` message on the engine's existing queue (no new queue to
 * provision). The consumer builds the CSV from D1 and stores it in the IMAGES bucket
 * under `exports/<seller>/<job>.csv` (private; the web Worker serves it to the seller
 * only). Links work for 24h (IO-export-expiry); the cron sweep deletes expired files.
 */

export const ExportJobMessage = Schema.Struct({
	kind: Schema.Literal("export_job"),
	job_id: Schema.String,
	traceparent: Schema.optional(Schema.String),
});
export type ExportJobMessage = typeof ExportJobMessage.Type;
export const isExportJobMessage = Schema.is(ExportJobMessage);

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const ExportRequestInput = Schema.Struct({
	saleId: Id,
	sellerId: Id,
	kind: Schema.Literals(EXPORT_KINDS),
});
export type ExportRequestInput = typeof ExportRequestInput.Type;

export type ExportRequestOutcome =
	| { readonly ok: true; readonly value: { readonly jobId: string } }
	| { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Exports a seller may have in progress at once; more waits until one finishes. */
export const MAX_RUNNING_EXPORTS = 5;

const JOB_KIND: Readonly<Record<ExportKind, string>> = {
	items: "export_items",
	orders: "export_orders",
	pirate_ship: "export_shipping",
	shipping_generic: "export_shipping",
};

const LAYOUT: Readonly<Record<ExportKind, string | null>> = {
	items: null,
	orders: null,
	pirate_ship: "pirate_ship",
	shipping_generic: "generic",
};

export const exportKey = (sellerId: string, jobId: string) => `exports/${sellerId}/${jobId}.csv`;

class ExportStoreError extends Data.TaggedError("ExportStoreError")<{ readonly cause: unknown }> {}

const attempt = <A>(thunk: () => Promise<A>) =>
	Effect.tryPromise({ try: thunk, catch: (cause) => new ExportStoreError({ cause }) });

/**
 * A seller asks for an export of one of their sales.
 *
 * @spec IO-export-expiry — every export is audit-logged (who, when, which sale) as it is requested.
 */
export const requestExport = (env: Pick<EngineEnv, "DB" | "NOTIFICATIONS">, input: unknown) =>
	Effect.gen(function* () {
		const { saleId, sellerId, kind } = yield* Schema.decodeUnknownEffect(ExportRequestInput)(input);
		const now = yield* Clock.currentTimeMillis;
		const db = env.DB;
		const sale = yield* attempt(() =>
			db
				.prepare("SELECT id FROM sales WHERE id = ?1 AND seller_id = ?2 AND status != 'deleted'")
				.bind(saleId, sellerId)
				.first<{ id: string }>(),
		);
		if (!sale) {
			const missing: ExportRequestOutcome = {
				ok: false,
				error: { code: "not_found", message: "No such sale" },
			};
			return missing;
		}
		const running = yield* attempt(() =>
			db
				.prepare(
					"SELECT count(*) AS n FROM io_jobs WHERE seller_id = ?1 AND status = 'applying' AND kind LIKE 'export_%'",
				)
				.bind(sellerId)
				.first<{ n: number }>(),
		);
		if ((running?.n ?? 0) >= MAX_RUNNING_EXPORTS) {
			const busy: ExportRequestOutcome = {
				ok: false,
				error: {
					code: "too_many_exports",
					message: "A few exports are still running. Try again in a minute.",
				},
			};
			return busy;
		}
		const jobId = uuidv7();
		yield* attempt(() =>
			db.batch([
				db
					.prepare(
						"INSERT INTO io_jobs (id, seller_id, sale_id, kind, status, format, layout, created_at) VALUES (?1, ?2, ?3, ?4, 'applying', 'csv', ?5, ?6)",
					)
					.bind(jobId, sellerId, saleId, JOB_KIND[kind], LAYOUT[kind], now),
				db
					.prepare(
						"INSERT INTO audit_log (id, sale_id, item_id, actor_id, action, data, created_at) VALUES (?1, ?2, NULL, ?3, 'export_requested', ?4, ?5)",
					)
					.bind(uuidv7(), saleId, sellerId, JSON.stringify({ input: { jobId, kind } }), now),
			]),
		);
		const sent = yield* Effect.exit(
			attempt(() =>
				env.NOTIFICATIONS.send({ kind: "export_job", job_id: jobId } satisfies ExportJobMessage, {
					contentType: "json",
				}),
			),
		);
		if (sent._tag === "Failure") {
			yield* attempt(() =>
				db
					.prepare("UPDATE io_jobs SET status = 'failed', finished_at = ?2 WHERE id = ?1")
					.bind(jobId, now)
					.run(),
			);
			return yield* Effect.failCause(sent.cause);
		}
		yield* Effect.logInfo("export requested").pipe(
			Effect.annotateLogs({ job_id: jobId, sale_id: saleId, kind }),
		);
		const outcome: ExportRequestOutcome = { ok: true, value: { jobId } };
		return outcome;
	});

// ---------------------------------------------------------------------------
// Building the file (queue consumer)

interface JobRow {
	readonly id: string;
	readonly seller_id: string;
	readonly sale_id: string | null;
	readonly kind: string;
	readonly layout: string | null;
	readonly status: string;
}

const exportKindOf = (job: JobRow): ExportKind | null => {
	if (job.kind === "export_items") return "items";
	if (job.kind === "export_orders") return "orders";
	if (job.kind === "export_shipping") return job.layout === "generic" ? "shipping_generic" : "pirate_ship";
	return null;
};

interface ItemExportRow extends ItemImportRow {
	readonly state: string;
}

async function itemsTable(db: D1Database, saleId: string): Promise<Table> {
	const [items, winners] = await db.batch([
		db
			.prepare(
				`SELECT id, sku, game_id, kind, title, description_md, price_cents, quantity, offers_mode, min_offer_cents,
					shipping_override_cents, attributes, sort_order, state FROM items WHERE sale_id = ?1 ORDER BY sort_order, id`,
			)
			.bind(saleId),
		db
			.prepare(
				`SELECT e.item_id, u.handle, e.amount_cents FROM entries e JOIN items i ON i.id = e.item_id
					JOIN users u ON u.id = e.user_id
				WHERE i.sale_id = ?1 AND e.status IN ('won', 'fulfilled') ORDER BY e.won_at, e.id`,
			)
			.bind(saleId),
	]);
	const byItem = new Map<string, Array<{ handle: string | null; amount_cents: number }>>();
	for (const w of rowsOf<{ item_id: string; handle: string | null; amount_cents: number }>(winners)) {
		byItem.set(w.item_id, [...(byItem.get(w.item_id) ?? []), w]);
	}
	const rows = rowsOf<ItemExportRow>(items).map((row): ExportItem => {
		const won = byItem.get(row.id) ?? [];
		return {
			...toExisting(row),
			status: row.state,
			winnerHandle: won.length === 0 ? null : won.map((w) => w.handle ?? "").join("; "),
			finalPriceCents: won[0]?.amount_cents ?? null,
		};
	});
	return itemsExport(rows);
}

interface OrderRow {
	readonly id: string;
	readonly invoice_number: number | null;
	readonly status: InvoiceStatus;
	readonly buyer_id: string;
	readonly handle: string | null;
	readonly display_name: string;
	readonly shipping_address: string | null;
	readonly shipping_option_label: string | null;
	readonly shipping_cents: number;
	readonly adjustment_cents: number;
	readonly buyer_paid_at: number | null;
	readonly shipped_at: number | null;
	readonly carrier: string | null;
	readonly tracking_number: string | null;
}

interface OrderLineRow {
	readonly invoice_id: string;
	readonly description: string;
	readonly amount_cents: number;
	readonly refund_owed: number;
	readonly sku: string | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

function addressOf(raw: unknown): ShippingAddress | null {
	const value = parseJson(raw);
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const a: Record<string, unknown> = Object.fromEntries(Object.entries(value));
	return {
		name: text(a["name"]),
		line1: text(a["line1"]),
		line2: typeof a["line2"] === "string" ? a["line2"] : null,
		city: text(a["city"]),
		region: text(a["region"]),
		postalCode: text(a["postalCode"]),
		country: text(a["country"]),
	};
}

/**
 * The sale's invoices as order sources. Buyer data is selected column by column:
 * handle and display name only, never email or phone (IO-export-privacy).
 */
export async function orderSources(db: D1Database, saleId: string): Promise<OrderSource[]> {
	const [invoices, lines] = await db.batch([
		db
			.prepare(
				`SELECT i.id, i.invoice_number, i.status, i.buyer_id, u.handle, u.display_name, i.shipping_address,
					i.shipping_option_label, i.shipping_cents, i.adjustment_cents, i.buyer_paid_at, i.shipped_at,
					i.carrier, i.tracking_number
				FROM invoices i JOIN users u ON u.id = i.buyer_id
				WHERE i.sale_id = ?1 AND i.status != 'draft' ORDER BY i.invoice_number, i.id`,
			)
			.bind(saleId),
		db
			.prepare(
				`SELECT l.invoice_id, l.description, l.amount_cents, l.refund_owed, it.sku
				FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
					JOIN entries e ON e.id = l.entry_id JOIN items it ON it.id = e.item_id
				WHERE i.sale_id = ?1 ORDER BY l.created_at, l.id`,
			)
			.bind(saleId),
	]);
	const lineRows = rowsOf<OrderLineRow>(lines);
	return rowsOf<OrderRow>(invoices).map((row): OrderSource => ({
		invoiceNumber: invoiceNumberLabel(row.invoice_number, row.id),
		status: row.status,
		buyer: { id: row.buyer_id, handle: row.handle ?? "", displayName: row.display_name },
		shippingAddress: addressOf(row.shipping_address),
		lines: lineRows
			.filter((l) => l.invoice_id === row.id)
			.map((l) => ({
				title: l.description,
				sku: l.sku,
				amountCents: l.amount_cents,
				refundOwed: l.refund_owed === 1,
			})),
		shippingOptionLabel: row.shipping_option_label,
		shippingCents: row.shipping_cents,
		adjustmentCents: row.adjustment_cents,
		paidAt: row.buyer_paid_at,
		shippedAt: row.shipped_at,
		tracking:
			row.carrier !== null && row.tracking_number !== null
				? { carrier: row.carrier, number: row.tracking_number }
				: null,
	}));
}

export async function exportTable(db: D1Database, kind: ExportKind, saleId: string): Promise<Table> {
	if (kind === "items") return itemsTable(db, saleId);
	const orders = await orderSources(db, saleId);
	return kind === "orders" ? ordersExport(orders) : shippingExport(kind, orders);
}

export interface ExportDeps {
	readonly db: D1Database;
	readonly bucket: R2Bucket;
}

/** Builds one export and stores it. A job that is no longer running is skipped. */
export const runExportJob = (deps: ExportDeps, jobId: string, now: Millis) =>
	Effect.gen(function* () {
		const job = yield* attempt(() =>
			deps.db
				.prepare("SELECT id, seller_id, sale_id, kind, layout, status FROM io_jobs WHERE id = ?1")
				.bind(jobId)
				.first<JobRow>(),
		);
		const kind = job ? exportKindOf(job) : null;
		if (!job || job.status !== "applying" || kind === null || job.sale_id === null) return "skipped" as const;
		const saleId = job.sale_id;
		const table = yield* attempt(() => exportTable(deps.db, kind, saleId));
		const key = exportKey(job.seller_id, job.id);
		yield* attempt(() =>
			deps.bucket.put(key, encodeCsv(tableRows(table)), {
				httpMetadata: { contentType: "text/csv; charset=utf-8" },
			}),
		);
		yield* attempt(() =>
			deps.db
				.prepare(
					`UPDATE io_jobs SET status = 'done', result_key = ?2, row_count = ?3, finished_at = ?4, expires_at = ?5
					WHERE id = ?1 AND status = 'applying'`,
				)
				.bind(job.id, key, table.rows.length, now, exportExpiresAt(now))
				.run(),
		);
		yield* Effect.logInfo("export built").pipe(
			Effect.annotateLogs({ job_id: job.id, sale_id: saleId, rows: table.rows.length }),
		);
		return "done" as const;
	});

/** Marks a job failed after its last retry, so the seller sees it and can ask again. */
const failJob = (db: D1Database, jobId: string, now: Millis) =>
	attempt(() =>
		db
			.prepare("UPDATE io_jobs SET status = 'failed', finished_at = ?2 WHERE id = ?1 AND status = 'applying'")
			.bind(jobId, now)
			.run(),
	);

/** Max deliveries of one export message (the queue's max_retries is 5). */
const LAST_ATTEMPT = 5;

/** Handles one `export_job` message: ack when built or skipped, retry on a D1 or R2 failure. */
export const handleExportMessage = (message: Message, body: ExportJobMessage, deps: ExportDeps) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		yield* runExportJob(deps, body.job_id, now).pipe(
			Effect.andThen(Effect.sync(() => message.ack())),
			Effect.catchTag("ExportStoreError", (error) =>
				message.attempts >= LAST_ATTEMPT
					? Effect.logError("export failed", error.cause).pipe(
							Effect.andThen(failJob(deps.db, body.job_id, now)),
							Effect.andThen(Effect.sync(() => message.ack())),
						)
					: Effect.logWarning("export failed; will retry", error.cause).pipe(
							Effect.andThen(Effect.sync(() => message.retry())),
						),
			),
		);
	}).pipe(Effect.annotateLogs({ queue_message_id: message.id, job_id: body.job_id }));

/**
 * Cron: deletes the files of exports whose 24h link expired and marks them `expired`.
 *
 * @spec IO-export-expiry
 */
export const expireExports = (deps: ExportDeps) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const { results } = yield* attempt(() =>
			deps.db
				.prepare(
					"SELECT id, result_key FROM io_jobs WHERE status = 'done' AND expires_at <= ?1 AND kind LIKE 'export_%' LIMIT 100",
				)
				.bind(now)
				.all<{ id: string; result_key: string | null }>(),
		);
		const keys = results.map((r) => r.result_key).filter((k): k is string => k !== null);
		if (keys.length > 0) yield* attempt(() => deps.bucket.delete(keys));
		if (results.length > 0) {
			yield* attempt(() =>
				deps.db
					.prepare(
						"UPDATE io_jobs SET status = 'expired', result_key = NULL WHERE id IN (SELECT value FROM json_each(?1))",
					)
					.bind(JSON.stringify(results.map((r) => r.id)))
					.run(),
			);
		}
		yield* Effect.logInfo("expired exports removed").pipe(Effect.annotateLogs({ count: results.length }));
		return results.length;
	});
