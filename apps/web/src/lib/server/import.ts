import {
	applyCatalogAutofill,
	checkImportTarget,
	gameBySlug,
	matchCatalog,
	ok,
	planImport,
	reject,
	validateAttributes,
	validateImport,
	type ExistingItem,
	type ImportedItem,
	type ImportPlan,
	type MappedRow,
	type Millis,
	type Rejection,
	type Result,
	type Tier,
} from "@claimsale/core";
import { and, eq, inArray, sql, type Db } from "@claimsale/db";
import {
	auditLog,
	entries,
	ioJobRows,
	ioJobs,
	itemAttributes,
	itemImages,
	items,
	sales,
} from "@claimsale/db/schema";
import { Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { NO_GAME } from "#lib/listing-input.ts";
import { catalogLookup } from "./catalog.ts";
import { listItems, type ItemRow } from "./items.ts";

/**
 * Applying an item import (PLAN §3c.1, §3c.4): the browser parses, maps and previews
 * the file, then sends the rows here in batches of {@link IMPORT_BATCH_SIZE}.
 *
 * **The seam for WS-E.** PLAN §3c.4 applies imports "through an engine command", so a
 * scheduled sale's items go through its Durable Object lock. That RPC doesn't exist
 * yet, so {@link applyImportBatch} writes D1 directly, in one `db.batch()` per batch
 * with the idempotency rows in the same transaction. It is the only writer for
 * imports: the route calls it and nothing else, so WS-E replaces its body (or the
 * route's one call) with the engine RPC, taking the same request and result types.
 */

export const IMPORT_BATCH_SIZE = 100;

const Uuid = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const Cell = Schema.String.check(Schema.isMaxLength(20_000));

/** One batch, as the import page sends it. */
export const ImportBatchBody = Schema.Struct({
	/** Picked by the browser for the whole import; re-sending a batch reuses it. */
	importId: Uuid,
	format: Schema.Literals(["csv", "xlsx"]),
	/** Data rows in the whole file, for the job's progress. */
	totalRows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 })),
	rows: Schema.Array(
		Schema.Struct({
			row: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1_000_000 })),
			cells: Schema.Record(Schema.String.check(Schema.isMaxLength(64)), Cell),
		}),
	).check(Schema.isMaxLength(IMPORT_BATCH_SIZE)),
	/**
	 * "Remove items not in file": the items and SKUs the file names. Honoured once per
	 * import, when its first batch arrives.
	 */
	removeMissing: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				keepItemIds: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
					Schema.isMaxLength(2000),
				),
				keepSkus: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(2000)),
			}),
		),
	),
});
export type ImportBatchBody = typeof ImportBatchBody.Type;

export interface RowResult {
	readonly row: number;
	readonly outcome: "created" | "updated" | "skipped" | "error";
	/** The item the row created or matched; null for errors. */
	readonly itemId: string | null;
	/** For errors: the column ("" for the whole row). */
	readonly field: string;
	readonly message: string;
}

export interface ImportBatchResult {
	readonly rows: readonly RowResult[];
	/** Items removed by "remove items not in file" (only ever on the first batch). */
	readonly removed: number;
	/** R2 keys of the removed items' photos, for the caller to delete. */
	readonly removedR2Keys: readonly string[];
}

export type ImportRejection = Rejection<"not_found" | "sale_not_importable" | "import_conflict">;

// Many rows go through one JSON parameter (D1 allows 100 bound parameters per statement).
const jsonRows = (rows: unknown[]) => sql`json_each(${JSON.stringify(rows)})`;
const at = (index: number) => sql.raw(`json_extract(value, '$[${index}]')`);

const IMPORTED_COLUMNS = (item: ImportedItem) => {
	const attr = (key: string) => {
		const value = item.attributes[key];
		return typeof value === "string" ? value : null;
	};
	return {
		gameId: item.game ?? NO_GAME.id,
		kind: item.kind,
		title: item.title,
		descriptionMd: item.description,
		condition: attr("condition"),
		finish: attr("finish"),
		language: attr("language"),
		grader: attr("grader"),
		grade: attr("grade"),
		certNumber: attr("cert_number"),
		sku: item.sku,
		priceCents: item.priceCents,
		quantity: item.quantity,
		offersMode: item.offers === "min" ? ("on_min" as const) : item.offers,
		minOfferCents: item.minOfferCents,
		shippingOverrideCents: item.shippingOverrideCents,
		attributes: { ...item.attributes },
	};
};

/** A stored item as the import planner compares it. */
export function toExisting(row: ItemRow): ExistingItem {
	const attributes: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(row.attributes)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			attributes[key] = value;
	}
	return {
		id: row.id,
		sku: row.sku,
		game: row.gameId === NO_GAME.id ? null : row.gameId,
		kind: row.kind,
		title: row.title,
		description: row.descriptionMd,
		priceCents: row.priceCents,
		quantity: row.quantity,
		offers: row.offersMode === "on_min" ? "min" : row.offersMode,
		minOfferCents: row.minOfferCents,
		shippingOverrideCents: row.shippingOverrideCents,
		attributes,
	};
}

/**
 * Fills the catalog fields of matched rows (TCG-autofill-only, `fill-blanks`: what the
 * file says wins) and links the product. A row the catalog can't help stays as it is.
 */
async function autofill(
	db: Db,
	rows: readonly { row: number; item: ImportedItem }[],
): Promise<{ row: number; item: ImportedItem; catalogProductId: string | null }[]> {
	const lookup = catalogLookup(db);
	await lookup.prefetch(
		rows
			.map((r) => r.item.attributes["tcgplayer_product_id"])
			.filter((id): id is number => typeof id === "number"),
	);
	const out: { row: number; item: ImportedItem; catalogProductId: string | null }[] = [];
	for (const { row, item } of rows) {
		// oxlint-disable-next-line no-await-in-loop -- a few small indexed queries per row
		const match = await matchCatalog(item, lookup);
		if (match.status !== "matched") {
			out.push({ row, item, catalogProductId: null });
			continue;
		}
		const merged = applyCatalogAutofill(item, match.product, "fill-blanks");
		const game = merged.ok && merged.value.game !== null ? (gameBySlug(merged.value.game) ?? null) : null;
		// The catalog's text must still fit the schema (e.g. a very long set name); if not, keep the row's own.
		const valid =
			merged.ok && game !== null && validateAttributes(item.kind, game, merged.value.attributes).ok;
		const productId: unknown = Reflect.get(match.product, "productId");
		out.push({
			row,
			item: valid && merged.ok ? merged.value : item,
			catalogProductId: typeof productId === "number" ? String(productId) : null,
		});
	}
	return out;
}

const attributeRowsJson = (itemId: string, item: ImportedItem) =>
	Object.entries(item.attributes).map(([key, value]) =>
		typeof value === "number" && Number.isSafeInteger(value)
			? [itemId, key, null, value]
			: [itemId, key, String(value), null],
	);

/** Groups validation errors by row: the first field, all messages. */
function errorResults(errors: readonly { row: number; field: string; message: string }[]): RowResult[] {
	const byRow = new Map<number, { field: string; messages: string[] }>();
	for (const e of errors) {
		const entry = byRow.get(e.row) ?? { field: e.field, messages: [] };
		entry.messages.push(e.field ? `${e.field}: ${e.message}` : e.message);
		byRow.set(e.row, entry);
	}
	return [...byRow].map(([row, e]) => ({
		row,
		outcome: "error",
		itemId: null,
		field: e.field,
		message: e.messages.join("; "),
	}));
}

const fromRecorded = (r: typeof ioJobRows.$inferSelect): RowResult => ({
	row: r.rowNumber,
	outcome: r.outcome,
	itemId: r.targetId,
	field: r.field ?? "",
	message: r.message ?? "",
});

async function recordedRows(db: Db, jobId: string, rowNumbers: readonly number[]): Promise<RowResult[]> {
	if (rowNumbers.length === 0) return [];
	const rows = await db
		.select()
		.from(ioJobRows)
		.where(and(eq(ioJobRows.jobId, jobId), inArray(ioJobRows.rowNumber, [...rowNumbers])))
		.all();
	return rows.map(fromRecorded);
}

/**
 * "Remove items not in file", once per import: deletes the sale's items that the file
 * doesn't name by `item_id` or `sku`. Items with entries are never removed (the sale is
 * draft or scheduled, so none have any).
 *
 * @spec IO-import-upsert — removal only when the seller opted in.
 */
async function removeMissing(
	db: Db,
	sellerId: string,
	saleId: string,
	importId: string,
	keep: { readonly keepItemIds: readonly string[]; readonly keepSkus: readonly string[] },
	now: Millis,
): Promise<{ removed: number; r2Keys: string[] }> {
	const keepIds = new Set(keep.keepItemIds);
	const keepSkus = new Set(keep.keepSkus.map((s) => s.toLowerCase()));
	const current = await listItems(db, saleId);
	const candidates = current.filter(
		(item) => !keepIds.has(item.id) && (item.sku === null || !keepSkus.has(item.sku.toLowerCase())),
	);
	if (candidates.length === 0) return { removed: 0, r2Keys: [] };
	const ids = candidates.map((c) => c.id);
	const withEntries = new Set(
		(
			await db
				.selectDistinct({ itemId: entries.itemId })
				.from(entries)
				.where(inArray(entries.itemId, ids))
				.all()
		).map((r) => r.itemId),
	);
	const doomed = ids.filter((id) => !withEntries.has(id));
	if (doomed.length === 0) return { removed: 0, r2Keys: [] };
	const images = await db
		.select({ key: itemImages.r2Key })
		.from(itemImages)
		.where(inArray(itemImages.itemId, doomed))
		.all();
	await db.batch([
		db.delete(items).where(inArray(items.id, doomed)),
		db.update(ioJobs).set({ removed: doomed.length }).where(eq(ioJobs.id, importId)),
		db.insert(auditLog).values({
			id: uuidv7(),
			saleId,
			itemId: null,
			actorId: sellerId,
			action: "items_import_removed",
			data: { importId, itemIds: doomed },
			createdAt: now,
		}),
	]);
	return { removed: doomed.length, r2Keys: images.map((i) => i.key) };
}

/**
 * Applies one batch of an item import.
 *
 * @spec IO-import-target — only into the seller's own draft or scheduled sale.
 * @spec IO-import-validate — every row is validated again here with core's shared
 * schema; an invalid row is recorded as an error and never written.
 * @spec IO-import-idempotent — each row's result is stored under (import_id, row) in
 * the same D1 batch as its write; a re-sent row returns the stored result and writes
 * nothing.
 * @spec IO-import-upsert — rows update the item with the same `item_id` / `sku`,
 * others create; unlisted items stay unless the seller opted into removal.
 * @spec IO-import-cap — a free seller's 10-item cap is applied to the sale's items as
 * they stand when the batch arrives; rows past it are errors that say how many fit.
 */
export async function applyImportBatch(
	db: Db,
	seller: { readonly id: string; readonly tier: Tier },
	saleId: string,
	request: ImportBatchBody,
	now: Millis,
): Promise<Result<ImportBatchResult, ImportRejection>> {
	const sale = await db
		.select({ id: sales.id, status: sales.status })
		.from(sales)
		.where(and(eq(sales.id, saleId), eq(sales.sellerId, seller.id)))
		.get();
	if (!sale || sale.status === "deleted") return reject("not_found", "No such sale");
	const target = checkImportTarget(sale.status);
	if (!target.ok) return target;

	const importId = request.importId.toLowerCase();
	const job = await db.select().from(ioJobs).where(eq(ioJobs.id, importId)).get();
	let removal = { removed: 0, r2Keys: [] as string[] };
	if (job) {
		if (job.sellerId !== seller.id || job.saleId !== saleId || job.kind !== "item_import") {
			return reject("import_conflict", "This import ID belongs to another import");
		}
	} else {
		const created = await db
			.insert(ioJobs)
			.values({
				id: importId,
				sellerId: seller.id,
				saleId,
				kind: "item_import",
				status: "applying",
				format: request.format,
				rowCount: request.totalRows,
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: ioJobs.id });
		if (created.length > 0 && request.removeMissing) {
			removal = await removeMissing(db, seller.id, saleId, importId, request.removeMissing, now);
		}
	}

	const rowNumbers = request.rows.map((r) => r.row);
	const recorded = await recordedRows(db, importId, rowNumbers);
	const done = new Set(recorded.map((r) => r.row));
	// Duplicate row numbers inside one batch count once.
	const fresh: MappedRow[] = [];
	for (const row of request.rows) {
		if (!done.has(row.row)) {
			done.add(row.row);
			fresh.push(row);
		}
	}
	const finish = (rows: readonly RowResult[]): ImportBatchResult => ({
		rows: rows.toSorted((a, b) => a.row - b.row),
		removed: removal.removed,
		removedR2Keys: removal.r2Keys,
	});
	if (fresh.length === 0) return ok(finish(recorded));

	const validated = validateImport(fresh, { sellerTier: seller.tier });
	const valid = validated.ok ? validated.value.items : [];
	const invalid: RowResult[] = validated.ok
		? errorResults(validated.value.errors)
		: fresh.map((r) => ({
				row: r.row,
				outcome: "error",
				itemId: null,
				field: "",
				message: "The row is empty",
			}));

	const filled = await autofill(db, valid);
	const catalogIds = new Map(filled.map((f) => [f.row, f.catalogProductId]));
	const existingRows = await listItems(db, saleId);
	const plan: ImportPlan = planImport({
		rows: filled.map(({ row, item }) => ({ row, item })),
		existing: existingRows.map(toExisting),
		removeMissing: false,
		sellerTier: seller.tier,
	});

	const results: RowResult[] = [...invalid];
	const statements: Parameters<typeof db.batch>[0][number][] = [];
	const attributeRows: (string | number | null)[][] = [];
	const replacedAttributes: string[] = [];
	let sortOrder = existingRows.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
	const createdIds = new Map<number, string>();
	for (const { row, item } of plan.creates) {
		const id = uuidv7();
		createdIds.set(row, id);
		statements.push(
			db.insert(items).values({
				id,
				saleId,
				sortOrder: sortOrder++,
				...IMPORTED_COLUMNS(item),
				catalogProductId: catalogIds.get(row) ?? null,
				createdAt: now,
				updatedAt: now,
			}),
		);
		attributeRows.push(...attributeRowsJson(id, item));
	}
	for (const { row, itemId, item } of plan.updates) {
		statements.push(
			db
				.update(items)
				.set({
					...IMPORTED_COLUMNS(item),
					catalogProductId: catalogIds.get(row) ?? null,
					version: sql`${items.version} + 1`,
					updatedAt: now,
				})
				.where(and(eq(items.id, itemId), eq(items.saleId, saleId))),
		);
		replacedAttributes.push(itemId);
		attributeRows.push(...attributeRowsJson(itemId, item));
	}
	for (const outcome of plan.outcomes) {
		if (outcome.outcome === "error") {
			results.push({
				row: outcome.row,
				outcome: "error",
				itemId: null,
				field: outcome.field,
				message: outcome.message,
			});
		} else if (outcome.outcome === "created") {
			results.push({
				row: outcome.row,
				outcome: "created",
				itemId: createdIds.get(outcome.row) ?? null,
				field: "",
				message: "",
			});
		} else if (outcome.outcome === "updated") {
			results.push({
				row: outcome.row,
				outcome: "updated",
				itemId: outcome.itemId,
				field: "",
				message: `Changed: ${outcome.changed.join(", ")}`,
			});
		} else {
			results.push({
				row: outcome.row,
				outcome: "skipped",
				itemId: outcome.itemId,
				field: "",
				message: "No changes",
			});
		}
	}
	if (replacedAttributes.length > 0) {
		statements.push(
			db
				.delete(itemAttributes)
				.where(sql`${itemAttributes.itemId} IN (SELECT value FROM ${jsonRows(replacedAttributes)})`),
		);
	}
	if (attributeRows.length > 0) {
		statements.push(
			db.insert(itemAttributes).select(
				db
					.select({
						itemId: sql<string>`${at(0)}`.as("item_id"),
						key: sql<string>`${at(1)}`.as("key"),
						valueText: sql<string | null>`${at(2)}`.as("value_text"),
						valueNum: sql<number | null>`${at(3)}`.as("value_num"),
					})
					.from(jsonRows(attributeRows)),
			),
		);
	}
	const jobRows = results.map((r) => [r.row, r.outcome, r.itemId, r.field, r.message.slice(0, 2000)]);
	// Plain INSERT: a concurrent copy of this batch makes it fail, so the whole batch rolls back.
	statements.push(
		db.insert(ioJobRows).select(
			db
				.select({
					jobId: sql<string>`${importId}`.as("job_id"),
					rowNumber: sql<number>`${at(0)}`.as("row_number"),
					outcome: sql<RowResult["outcome"]>`${at(1)}`.as("outcome"),
					targetId: sql<string | null>`${at(2)}`.as("target_id"),
					field: sql<string>`${at(3)}`.as("field"),
					message: sql<string>`${at(4)}`.as("message"),
				})
				.from(jsonRows(jobRows)),
		),
	);
	const count = (outcome: RowResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
	const complete = sql`(SELECT count(*) FROM ${ioJobRows} WHERE ${ioJobRows.jobId} = ${importId}) >= ${ioJobs.rowCount}`;
	statements.push(
		db
			.update(ioJobs)
			.set({
				created: sql`${ioJobs.created} + ${count("created")}`,
				updated: sql`${ioJobs.updated} + ${count("updated")}`,
				skipped: sql`${ioJobs.skipped} + ${count("skipped")}`,
				errors: sql`${ioJobs.errors} + ${count("error")}`,
				status: sql`CASE WHEN ${complete} THEN 'done' ELSE ${ioJobs.status} END`,
				finishedAt: sql`CASE WHEN ${complete} THEN ${now} ELSE ${ioJobs.finishedAt} END`,
			})
			.where(eq(ioJobs.id, importId)),
	);
	statements.push(
		db.insert(auditLog).values({
			id: uuidv7(),
			saleId,
			itemId: null,
			actorId: seller.id,
			action: "items_imported",
			data: {
				importId,
				rows: rowNumbers.length,
				created: count("created"),
				updated: count("updated"),
				skipped: count("skipped"),
				errors: count("error"),
			},
			createdAt: now,
		}),
		db.update(sales).set({ updatedAt: now }).where(eq(sales.id, saleId)),
	);

	try {
		const [first, ...rest] = statements;
		await db.batch([first!, ...rest]);
	} catch (error) {
		// A concurrent copy of the same batch got there first: answer with what it recorded.
		const again = await recordedRows(db, importId, rowNumbers);
		if (again.length === new Set(rowNumbers).size) return ok(finish(again));
		throw error;
	}
	return ok(finish([...recorded, ...results]));
}

/** The seller's import jobs' results so far (rows in file order), for a results page or a retry. */
export async function importResults(db: Db, sellerId: string, importId: string): Promise<RowResult[] | null> {
	const job = await db
		.select({ sellerId: ioJobs.sellerId })
		.from(ioJobs)
		.where(eq(ioJobs.id, importId.toLowerCase()))
		.get();
	if (!job || job.sellerId !== sellerId) return null;
	const rows = await db
		.select()
		.from(ioJobRows)
		.where(eq(ioJobRows.jobId, importId.toLowerCase()))
		.orderBy(ioJobRows.rowNumber)
		.all();
	return rows.map(fromRecorded);
}
