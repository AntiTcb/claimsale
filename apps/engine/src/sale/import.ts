import {
	checkImportTarget,
	ok,
	planImport,
	reject,
	validateImport,
	type Attributes,
	type ExistingItem,
	type ImportedItem,
	type ItemKind,
	type Millis,
	type OffersMode,
	type RowOutcome,
} from "@claimsale/core";
import { parseJson } from "./settings.ts";
import { newId, Work, type SaleRecord } from "./store.ts";
import type { Outcome } from "./writer.ts";

/**
 * Applies one batch of an item import (PLAN §3c.4). The browser validates the whole
 * file and sends rows in batches of up to 100; the engine validates every row again,
 * plans the batch against the sale's current items and applies it in one D1 batch.
 * Applied rows are recorded per (`importId`, row), so a re-sent batch is a no-op that
 * returns the first outcome.
 */

export const MAX_IMPORT_BATCH = 100;

export interface ImportBatchInput {
	readonly sellerId: string;
	/** Chosen by the browser per file (a UUID); the same value for every batch of it. */
	readonly importId: string;
	/** Mapped rows: the spreadsheet line number and its cells by import column key. */
	readonly rows: ReadonlyArray<{ readonly row: number; readonly cells: Readonly<Record<string, string>> }>;
}

/** A row's outcome; `created` carries the new item's ID (for attaching photos). */
export type ImportRowResult =
	| Exclude<RowOutcome, { outcome: "created" }>
	| { readonly row: number; readonly outcome: "created"; readonly itemId: string };

export interface ImportBatchResult {
	readonly outcomes: readonly ImportRowResult[];
	/** Rows answered from an earlier delivery of the same batch. */
	readonly replayed: number;
}

interface ItemImportRow {
	readonly id: string;
	readonly sku: string | null;
	readonly game_id: string;
	readonly kind: ItemKind;
	readonly title: string;
	readonly description_md: string;
	readonly price_cents: number;
	readonly quantity: number;
	readonly offers_mode: "off" | "on" | "on_min";
	readonly min_offer_cents: number | null;
	readonly shipping_override_cents: number | null;
	readonly attributes: string | null;
	readonly sort_order: number;
}

const toDbOffers = (mode: OffersMode) => (mode === "min" ? "on_min" : mode);
const fromDbOffers = (mode: ItemImportRow["offers_mode"]): OffersMode => (mode === "on_min" ? "min" : mode);
/** Items created without a game (accessories, lots) store this game ID. */
export const NO_GAME = "other";

function toExisting(row: ItemImportRow): ExistingItem {
	const attributes = parseJson(row.attributes);
	return {
		id: row.id,
		sku: row.sku,
		game: row.game_id === NO_GAME ? null : row.game_id,
		kind: row.kind,
		title: row.title,
		description: row.description_md,
		priceCents: row.price_cents,
		quantity: row.quantity,
		offers: fromDbOffers(row.offers_mode),
		minOfferCents: row.min_offer_cents,
		shippingOverrideCents: row.shipping_override_cents,
		attributes: (attributes !== null && typeof attributes === "object" ? attributes : {}) as Attributes,
	};
}

const text = (attributes: Attributes, key: string) => {
	const value = attributes[key];
	return typeof value === "string" ? value : null;
};

/** The item columns an imported row sets (the filterable ones mirror the attributes). */
function itemColumns(item: ImportedItem) {
	return {
		sku: item.sku,
		gameId: item.game ?? NO_GAME,
		kind: item.kind,
		title: item.title,
		description: item.description,
		priceCents: item.priceCents,
		quantity: item.quantity,
		offersMode: toDbOffers(item.offers),
		minOfferCents: item.offers === "min" ? item.minOfferCents : null,
		shippingOverrideCents: item.shippingOverrideCents,
		attributes: JSON.stringify(item.attributes),
		condition: text(item.attributes, "condition"),
		finish: text(item.attributes, "finish"),
		language: text(item.attributes, "language"),
		grader: text(item.attributes, "grader"),
		grade: text(item.attributes, "grade"),
		certNumber: text(item.attributes, "cert_number"),
	};
}

function attributeStatements(db: D1Database, itemId: string, attributes: Attributes): D1PreparedStatement[] {
	const out = [db.prepare("DELETE FROM item_attributes WHERE item_id = ?1").bind(itemId)];
	for (const [key, value] of Object.entries(attributes)) {
		const num = typeof value === "number" && Number.isSafeInteger(value) ? value : null;
		out.push(
			db
				.prepare("INSERT INTO item_attributes (item_id, key, value_text, value_num) VALUES (?1, ?2, ?3, ?4)")
				.bind(itemId, key, num === null ? String(value) : null, num),
		);
	}
	return out;
}

/**
 * Applies an import batch. The caller holds the sale lock.
 *
 * @spec IO-import-target — only draft and scheduled sales take imports.
 * @spec IO-import-validate — every row is validated again on the server; invalid rows never apply.
 * @spec IO-import-upsert — rows update by `item_id` / `sku`, others create; nothing is removed.
 * @spec IO-import-cap — the free item cap counts the items already in the sale, across batches.
 * @spec IO-import-idempotent — a re-sent (`importId`, row) returns its first outcome and changes nothing.
 */
export async function planImportBatch(
	db: D1Database,
	sale: SaleRecord,
	input: ImportBatchInput,
	now: Millis,
): Promise<Outcome<{ work: Work; value: ImportBatchResult }>> {
	if (input.sellerId !== sale.sellerId) return reject("not_found", "No such sale");
	const target = checkImportTarget(sale.sale.status);
	if (!target.ok) return target;
	if (input.rows.length > MAX_IMPORT_BATCH) {
		return reject("batch_too_large", `Send at most ${MAX_IMPORT_BATCH} rows per batch`);
	}
	const work = new Work(db, sale, now);
	const [applied, existing] = await db.batch([
		db
			.prepare(
				"SELECT row, item_id, outcome FROM import_rows WHERE import_id = ?1 AND sale_id = ?2 AND row IN (SELECT value FROM json_each(?3))",
			)
			.bind(input.importId, sale.id, JSON.stringify(input.rows.map((r) => r.row))),
		db
			.prepare(
				`SELECT id, sku, game_id, kind, title, description_md, price_cents, quantity, offers_mode, min_offer_cents,
					shipping_override_cents, attributes, sort_order FROM items WHERE sale_id = ?1 ORDER BY sort_order, id`,
			)
			.bind(sale.id),
	]);
	const done = new Map(
		(applied!.results as Array<{ row: number; item_id: string | null; outcome: string }>).map((r) => [r.row, r]),
	);
	const replayed: ImportRowResult[] = [...done.values()].map((r) =>
		r.outcome === "created"
			? { row: r.row, outcome: "created", itemId: r.item_id! }
			: r.outcome === "updated"
				? { row: r.row, outcome: "updated", itemId: r.item_id!, changed: [] }
				: { row: r.row, outcome: "skipped", itemId: r.item_id!, reason: "unchanged" },
	);
	const fresh = input.rows.filter((r) => !done.has(r.row));
	if (fresh.length === 0) return ok({ work, value: { outcomes: replayed.toSorted((a, b) => a.row - b.row), replayed: replayed.length } });

	const validated = validateImport(fresh, { sellerTier: sale.sellerTier });
	if (!validated.ok) return validated;
	const itemRows = existing!.results as ItemImportRow[];
	const plan = planImport({
		rows: validated.value.items,
		existing: itemRows.map(toExisting),
		removeMissing: false,
		sellerTier: sale.sellerTier,
	});

	const created = new Map<number, string>();
	let sortOrder = itemRows.reduce((max, r) => Math.max(max, r.sort_order), -1);
	for (const { row, item } of plan.creates) {
		const id = newId();
		created.set(row, id);
		const c = itemColumns(item);
		work.extra.push(
			db
				.prepare(
					`INSERT INTO items (id, sale_id, sort_order, game_id, kind, title, description_md, condition, finish, language,
						attributes, grader, grade, cert_number, sku, price_cents, quantity, offers_mode, min_offer_cents,
						shipping_override_cents, created_at, updated_at)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?21)`,
				)
				.bind(
					id,
					sale.id,
					++sortOrder,
					c.gameId,
					c.kind,
					c.title,
					c.description,
					c.condition,
					c.finish,
					c.language,
					c.attributes,
					c.grader,
					c.grade,
					c.certNumber,
					c.sku,
					c.priceCents,
					c.quantity,
					c.offersMode,
					c.minOfferCents,
					c.shippingOverrideCents,
					now,
				),
			...attributeStatements(db, id, item.attributes),
		);
	}
	for (const { itemId, item } of plan.updates) {
		const c = itemColumns(item);
		work.extra.push(
			db
				.prepare(
					`UPDATE items SET game_id = ?1, kind = ?2, title = ?3, description_md = ?4, condition = ?5, finish = ?6,
						language = ?7, attributes = ?8, grader = ?9, grade = ?10, cert_number = ?11, sku = ?12, price_cents = ?13,
						quantity = ?14, offers_mode = ?15, min_offer_cents = ?16, shipping_override_cents = ?17,
						version = version + 1, updated_at = ?18
					WHERE id = ?19 AND sale_id = ?20`,
				)
				.bind(
					c.gameId,
					c.kind,
					c.title,
					c.description,
					c.condition,
					c.finish,
					c.language,
					c.attributes,
					c.grader,
					c.grade,
					c.certNumber,
					c.sku,
					c.priceCents,
					c.quantity,
					c.offersMode,
					c.minOfferCents,
					c.shippingOverrideCents,
					now,
					itemId,
					sale.id,
				),
			...attributeStatements(db, itemId, item.attributes),
		);
	}

	const outcomes: ImportRowResult[] = [
		...validated.value.errors.map((e) => ({ row: e.row, outcome: "error" as const, field: e.field, message: e.message })),
		...plan.outcomes.map((o): ImportRowResult => (o.outcome === "created" ? { ...o, itemId: created.get(o.row)! } : o)),
	];
	for (const outcome of outcomes) {
		if (outcome.outcome === "error") continue;
		work.extra.push(
			db
				.prepare(
					"INSERT INTO import_rows (import_id, row, sale_id, item_id, outcome, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
				)
				.bind(input.importId, outcome.row, sale.id, outcome.itemId, outcome.outcome, now),
		);
	}
	const counts = { created: plan.creates.length, updated: plan.updates.length, errors: outcomes.filter((o) => o.outcome === "error").length };
	if (counts.created + counts.updated > 0) {
		work.extra.push(db.prepare("UPDATE sales SET updated_at = ?1 WHERE id = ?2").bind(now, sale.id));
		work.audit({
			action: "items_imported",
			actorId: input.sellerId,
			itemId: null,
			input: { importId: input.importId, rows: fresh.map((r) => r.row), ...counts },
			events: [],
		});
	}
	return ok({
		work,
		value: {
			outcomes: [...replayed, ...outcomes].toSorted((a, b) => a.row - b.row),
			replayed: replayed.length,
		},
	});
}
