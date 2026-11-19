import {
	applyCatalogAutofill,
	checkImportTarget,
	errorResults,
	gameBySlug,
	IMPORT_BATCH_SIZE,
	isNoGame,
	matchCatalog,
	NO_GAME_ID,
	ok,
	planImport,
	planResult,
	reject,
	validateAttributes,
	validateImport,
	type Attributes,
	type ExistingItem,
	type ImportBatchBody,
	type ImportBatchResult,
	type ImportedItem,
	type ImportRowResult,
	type ItemKind,
	type MappedRow,
	type Millis,
	type OffersMode,
} from "@claimsale/core";
import { d1CatalogLookup, type CatalogRow } from "../catalog/lookup.ts";
import { rowsOf } from "./rows.ts";
import { parseJson } from "./settings.ts";
import type { SaleStorage } from "./storage.ts";
import { newId, Work, type SaleRecord } from "./store.ts";
import type { Outcome } from "./writer.ts";

/**
 * Applies one batch of an item import (PLAN §3c.1, §3c.4) inside the sale's
 * SaleEngine, under the sale lock, so batches of one sale apply one at a time and
 * never race the sale's other writes. The browser validates and previews the whole
 * file, then sends rows in batches of up to 100; here every row is validated again,
 * matched to the catalog, planned against the sale's current items with core's
 * `planImport`, and written in one D1 batch together with its result row in
 * `io_job_rows` (the idempotency record) and the job's counters in `io_jobs`.
 */

export const MAX_IMPORT_BATCH = IMPORT_BATCH_SIZE;

export interface ImportBatchInput extends ImportBatchBody {
	readonly sellerId: string;
}

export type { ImportBatchResult, ImportRowResult };

export interface ItemImportRow {
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

interface JobRow {
	readonly seller_id: string;
	readonly sale_id: string | null;
	readonly kind: string;
}

const toDbOffers = (mode: OffersMode) => (mode === "min" ? "on_min" : mode);
const fromDbOffers = (mode: ItemImportRow["offers_mode"]): OffersMode => (mode === "on_min" ? "min" : mode);

/** Stored attributes: a JSON object of text, numbers and booleans; anything else is dropped. */
function attributesOf(value: unknown): Attributes {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string | number | boolean> = {};
	for (const [key, v] of Object.entries(value)) {
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
	}
	return out;
}

export function toExisting(row: ItemImportRow): ExistingItem {
	return {
		id: row.id,
		sku: row.sku,
		game: isNoGame(row.game_id) ? null : row.game_id,
		kind: row.kind,
		title: row.title,
		description: row.description_md,
		priceCents: row.price_cents,
		quantity: row.quantity,
		offers: fromDbOffers(row.offers_mode),
		minOfferCents: row.min_offer_cents,
		shippingOverrideCents: row.shipping_override_cents,
		attributes: attributesOf(parseJson(row.attributes)),
	};
}

const text = (attributes: Attributes, key: string) => {
	const value = attributes[key];
	return typeof value === "string" ? value : null;
};

/** The item columns an imported row sets, in the order of {@link ITEM_COLUMNS}. */
function itemValues(item: ImportedItem, catalogProductId: string | null) {
	return [
		item.game ?? NO_GAME_ID,
		item.kind,
		item.title,
		item.description,
		text(item.attributes, "condition"),
		text(item.attributes, "finish"),
		text(item.attributes, "language"),
		JSON.stringify(item.attributes),
		text(item.attributes, "grader"),
		text(item.attributes, "grade"),
		text(item.attributes, "cert_number"),
		item.sku,
		item.priceCents,
		item.quantity,
		toDbOffers(item.offers),
		item.offers === "min" ? item.minOfferCents : null,
		item.shippingOverrideCents,
		catalogProductId,
	];
}

const ITEM_COLUMNS = [
	"game_id",
	"kind",
	"title",
	"description_md",
	"condition",
	"finish",
	"language",
	"attributes",
	"grader",
	"grade",
	"cert_number",
	"sku",
	"price_cents",
	"quantity",
	"offers_mode",
	"min_offer_cents",
	"shipping_override_cents",
	"catalog_product_id",
] as const;

/**
 * Fills the catalog fields of rows that match the catalog (TCG-autofill-only,
 * `fill-blanks`: what the file says wins) and links the product. A row the catalog
 * can't help, or whose catalog text wouldn't fit the schema, stays as it is.
 */
async function autofill(
	db: D1Database,
	rows: readonly { row: number; item: ImportedItem }[],
): Promise<{ row: number; item: ImportedItem; catalogProductId: string | null }[]> {
	const lookup = d1CatalogLookup(db);
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
		const fits =
			merged.ok && game !== null && validateAttributes(item.kind, game, merged.value.attributes).ok;
		// d1CatalogLookup returns CatalogRow, which carries the row ID.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		const productId = (match.product as CatalogRow).productId;
		out.push({ row, item: fits && merged.ok ? merged.value : item, catalogProductId: String(productId) });
	}
	return out;
}

/** The item_attributes rows for an item, as [item_id, key, value_text, value_num]. */
const attributeRowsOf = (itemId: string, item: ImportedItem) =>
	Object.entries(item.attributes).map(([key, value]) =>
		typeof value === "number" && Number.isSafeInteger(value)
			? [itemId, key, null, value]
			: [itemId, key, String(value), null],
	);

/** Many values through one JSON parameter (D1 allows 100 bound parameters per statement). */
const json = (values: unknown) => JSON.stringify(values);

/**
 * Applies an import batch. The caller holds the sale lock.
 *
 * @spec IO-import-target — only the seller's own draft or scheduled sale takes imports.
 * @spec IO-import-validate — every row is validated again with core's shared schema;
 * invalid rows are recorded as errors and never written.
 * @spec IO-import-idempotent — each row's result is stored under (import_id, row) in
 * `io_job_rows`, in the same D1 batch as its write; a re-sent row returns that result
 * and changes nothing.
 * @spec IO-import-upsert — rows update the item with the same `item_id` / `sku`,
 * others create; unlisted items stay unless the seller opted into removal, which runs
 * once, with the import's first batch.
 * @spec IO-import-cap — the free item cap counts the items in the sale as the batch
 * applies (after any removal); rows past it are errors that say how many fit.
 */
export async function planImportBatch(
	/** D1-backed: an import writes items and its job rows straight to D1 (the engine copies them in after). */
	storage: SaleStorage,
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
	const importId = input.importId.toLowerCase();
	const rowNumbers = input.rows.map((r) => r.row);
	const db = storage.d1;
	const work = new Work(storage, sale, now);
	const [jobs, recordedRows, existing] = await db.batch([
		db.prepare("SELECT seller_id, sale_id, kind FROM io_jobs WHERE id = ?1").bind(importId),
		db
			.prepare(
				`SELECT row_number, outcome, target_id, field, message FROM io_job_rows
				WHERE job_id = ?1 AND row_number IN (SELECT value FROM json_each(?2))`,
			)
			.bind(importId, json(rowNumbers)),
		db
			.prepare(
				`SELECT id, sku, game_id, kind, title, description_md, price_cents, quantity, offers_mode, min_offer_cents,
					shipping_override_cents, attributes, sort_order FROM items WHERE sale_id = ?1 ORDER BY sort_order, id`,
			)
			.bind(sale.id),
	]);
	const job = rowsOf<JobRow>(jobs)[0];
	if (job && (job.seller_id !== sale.sellerId || job.sale_id !== sale.id || job.kind !== "item_import")) {
		return reject("import_conflict", "This import ID belongs to another import");
	}
	let itemRows = rowsOf<ItemImportRow>(existing);

	// The first batch of an import creates its job and runs the opted-in removal.
	let removedIds: string[] = [];
	let removedR2Keys: string[] = [];
	if (!job) {
		work.extra.push(
			db
				.prepare(
					`INSERT INTO io_jobs (id, seller_id, sale_id, kind, status, format, row_count, created_at)
					VALUES (?1, ?2, ?3, 'item_import', 'applying', ?4, ?5, ?6)`,
				)
				.bind(importId, sale.sellerId, sale.id, input.format, input.totalRows, now),
		);
		if (input.removeMissing) {
			const keepIds = new Set(input.removeMissing.keepItemIds);
			const keepSkus = new Set(input.removeMissing.keepSkus.map((s) => s.toLowerCase()));
			const candidates = itemRows
				.filter((r) => !keepIds.has(r.id) && (r.sku === null || !keepSkus.has(r.sku.toLowerCase())))
				.map((r) => r.id);
			if (candidates.length > 0) {
				const [withEntries, images] = await db.batch([
					db
						.prepare(
							"SELECT DISTINCT item_id FROM entries WHERE item_id IN (SELECT value FROM json_each(?1))",
						)
						.bind(json(candidates)),
					db
						.prepare(
							"SELECT item_id, r2_key FROM item_images WHERE item_id IN (SELECT value FROM json_each(?1))",
						)
						.bind(json(candidates)),
				]);
				const locked = new Set(rowsOf<{ item_id: string }>(withEntries).map((r) => r.item_id));
				removedIds = candidates.filter((id) => !locked.has(id));
				const removedSet = new Set(removedIds);
				removedR2Keys = rowsOf<{ item_id: string; r2_key: string }>(images)
					.filter((r) => removedSet.has(r.item_id))
					.map((r) => r.r2_key);
				if (removedIds.length > 0) {
					work.extra.push(
						db
							.prepare("DELETE FROM items WHERE sale_id = ?1 AND id IN (SELECT value FROM json_each(?2))")
							.bind(sale.id, json(removedIds)),
						db.prepare("UPDATE io_jobs SET removed = ?1 WHERE id = ?2").bind(removedIds.length, importId),
					);
					work.audit({
						action: "items_import_removed",
						actorId: sale.sellerId,
						itemId: null,
						input: { importId, itemIds: removedIds },
						events: [],
					});
					itemRows = itemRows.filter((r) => !removedSet.has(r.id));
				}
			}
		}
	}

	const recorded = rowsOf<{
		row_number: number;
		outcome: ImportRowResult["outcome"];
		target_id: string | null;
		field: string | null;
		message: string | null;
	}>(recordedRows).map((r): ImportRowResult => ({
		row: r.row_number,
		outcome: r.outcome,
		itemId: r.target_id,
		field: r.field ?? "",
		message: r.message ?? "",
	}));
	const done = new Set(recorded.map((r) => r.row));
	const fresh: MappedRow[] = [];
	for (const row of input.rows) {
		// A row number repeated inside the batch counts once.
		if (done.has(row.row)) continue;
		done.add(row.row);
		fresh.push(row);
	}
	const result = (rows: readonly ImportRowResult[]): ImportBatchResult => ({
		rows: rows.toSorted((a, b) => a.row - b.row),
		removed: removedIds.length,
		removedR2Keys,
	});
	if (fresh.length === 0) return ok({ work, value: result(recorded) });

	const validated = validateImport(fresh, { sellerTier: sale.sellerTier });
	const invalid: ImportRowResult[] = validated.ok
		? errorResults(validated.value.errors)
		: fresh.map((r) => ({
				row: r.row,
				outcome: "error",
				itemId: null,
				field: "",
				message: validated.error.message,
			}));
	const filled = await autofill(db, validated.ok ? validated.value.items : []);
	const catalogIds = new Map(filled.map((f) => [f.row, f.catalogProductId]));
	const plan = planImport({
		rows: filled.map(({ row, item }) => ({ row, item })),
		existing: itemRows.map(toExisting),
		removeMissing: false,
		sellerTier: sale.sellerTier,
	});

	const created = new Map<number, string>();
	const attributeRows: (string | number | null)[][] = [];
	const replaced: string[] = [];
	let sortOrder = itemRows.reduce((max, r) => Math.max(max, r.sort_order), -1);
	const placeholders = ITEM_COLUMNS.map((_, i) => `?${i + 5}`).join(", ");
	for (const { row, item } of plan.creates) {
		const id = newId();
		created.set(row, id);
		work.extra.push(
			db
				.prepare(
					`INSERT INTO items (id, sale_id, sort_order, created_at, updated_at, ${ITEM_COLUMNS.join(", ")})
					VALUES (?1, ?2, ?3, ?4, ?4, ${placeholders})`,
				)
				.bind(id, sale.id, ++sortOrder, now, ...itemValues(item, catalogIds.get(row) ?? null)),
		);
		attributeRows.push(...attributeRowsOf(id, item));
	}
	const assignments = ITEM_COLUMNS.map((column, i) => `${column} = ?${i + 4}`).join(", ");
	for (const { row, itemId, item } of plan.updates) {
		work.extra.push(
			db
				.prepare(
					`UPDATE items SET ${assignments}, version = version + 1, updated_at = ?3 WHERE id = ?1 AND sale_id = ?2`,
				)
				.bind(itemId, sale.id, now, ...itemValues(item, catalogIds.get(row) ?? null)),
		);
		replaced.push(itemId);
		attributeRows.push(...attributeRowsOf(itemId, item));
	}
	if (replaced.length > 0) {
		work.extra.push(
			db
				.prepare("DELETE FROM item_attributes WHERE item_id IN (SELECT value FROM json_each(?1))")
				.bind(json(replaced)),
		);
	}
	if (attributeRows.length > 0) {
		work.extra.push(
			db
				.prepare(
					`INSERT INTO item_attributes (item_id, key, value_text, value_num)
					SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?1)`,
				)
				.bind(json(attributeRows)),
		);
	}

	const results = [...invalid, ...plan.outcomes.map((o) => planResult(o, created))];
	// A plain INSERT: should a copy of this batch ever get past the lock, the whole D1 batch fails.
	work.extra.push(
		db
			.prepare(
				`INSERT INTO io_job_rows (job_id, row_number, outcome, target_id, field, message)
				SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]') FROM json_each(?2)`,
			)
			.bind(
				importId,
				json(results.map((r) => [r.row, r.outcome, r.itemId, r.field, r.message.slice(0, 2000)])),
			),
	);
	const count = (outcome: ImportRowResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
	work.extra.push(
		db
			.prepare(
				`UPDATE io_jobs SET created = created + ?2, updated = updated + ?3, skipped = skipped + ?4,
					errors = errors + ?5,
					status = CASE WHEN (SELECT count(*) FROM io_job_rows WHERE job_id = ?1) >= row_count THEN 'done' ELSE status END,
					finished_at = CASE WHEN (SELECT count(*) FROM io_job_rows WHERE job_id = ?1) >= row_count THEN ?6 ELSE finished_at END
				WHERE id = ?1`,
			)
			.bind(importId, count("created"), count("updated"), count("skipped"), count("error"), now),
		db.prepare("UPDATE sales SET updated_at = ?1 WHERE id = ?2").bind(now, sale.id),
	);
	work.audit({
		action: "items_imported",
		actorId: sale.sellerId,
		itemId: null,
		input: {
			importId,
			rows: rowNumbers.length,
			created: count("created"),
			updated: count("updated"),
			skipped: count("skipped"),
			errors: count("error"),
		},
		events: [],
	});
	return ok({ work, value: result([...recorded, ...results]) });
}
