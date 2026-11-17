import {
	encodeCsv,
	escapeFormula,
	formatCentsPlain,
	mapRows,
	mapRowsWithPreset,
	previewBulkMarketPrice,
	validateImport,
	validateImportRow,
	type BulkPricePreview,
	type ColumnMapping,
	type ImportedItem,
	type ImportPreset,
	type MappedRow,
	type RowError,
	type Tier,
} from "@claimsale/core";
import type { Table } from "./parse.ts";

/**
 * The import page's logic, kept out of the component so it can be tested on its
 * own: mapping, the preview, the "% of market" fill for blank prices, batching and
 * the results file.
 */

/** Rows per apply request (PLAN §3c.4). The server refuses bigger batches. */
export const BATCH_SIZE = 100;

export type MappingChoice =
	| { readonly kind: "preset"; readonly preset: ImportPreset }
	| { readonly kind: "columns"; readonly mapping: ColumnMapping };

export function mappedRows(table: Table, choice: MappingChoice): MappedRow[] {
	return choice.kind === "preset" ? mapRowsWithPreset(table, choice.preset) : mapRows(table, choice.mapping);
}

/** Per-row preview result, from core's own validation (the server re-runs it). */
export type RowPreview =
	| { readonly row: number; readonly ok: true; readonly item: ImportedItem }
	| { readonly row: number; readonly ok: false; readonly errors: readonly RowError[] };

export function previewRows(
	rows: readonly MappedRow[],
	tier: Tier,
): { readonly rows: readonly RowPreview[]; readonly fileError: string | null } {
	const validated = validateImport(rows, { sellerTier: tier });
	if (!validated.ok) return { rows: [], fileError: validated.error.message };
	const byRow = new Map<number, RowPreview>();
	for (const { row, item } of validated.value.items) byRow.set(row, { row, ok: true, item });
	for (const error of validated.value.errors) {
		const current = byRow.get(error.row);
		byRow.set(error.row, {
			row: error.row,
			ok: false,
			errors: [...(current && !current.ok ? current.errors : []), error],
		});
	}
	return { rows: [...byRow.values()].toSorted((a, b) => a.row - b.row), fileError: null };
}

/** A price that passes validation, so a priceless row can still be matched to the catalog. */
const PLACEHOLDER_PRICE = "0.05";

/**
 * Rows whose price cell is blank, read as if they had a price: the candidates for
 * "set blank prices to N % of market" (ManaBox exports have no prices). Rows with
 * other problems aren't candidates.
 */
export function blankPriceItems(
	rows: readonly MappedRow[],
	tier: Tier,
): { row: number; item: ImportedItem }[] {
	const out: { row: number; item: ImportedItem }[] = [];
	for (const { row, cells } of rows) {
		if ((cells["price"] ?? "").trim() !== "") continue;
		const result = validateImportRow({ ...cells, price: PLACEHOLDER_PRICE }, { sellerTier: tier });
		if (result.ok) out.push({ row, item: result.value });
	}
	return out;
}

/**
 * The "% of market" preview for blank prices.
 *
 * @spec TCG-market-pct — core rounds each price; nothing changes until the seller
 * applies the preview with {@link fillPrices}.
 */
export function previewBlankPrices(
	candidates: readonly { readonly row: number; readonly marketCents: number | null }[],
	percent: number,
): BulkPricePreview {
	return previewBulkMarketPrice(
		candidates.map((c) => ({
			itemId: String(c.row),
			priceCents: null,
			selected: false,
			marketCents: c.marketCents,
		})),
		percent,
		"blank",
	);
}

/** Writes an applied preview's prices into the rows' price cells. */
export function fillPrices(rows: readonly MappedRow[], preview: BulkPricePreview): MappedRow[] {
	const prices = new Map(preview.changes.map((c) => [Number(c.itemId), formatCentsPlain(c.toCents)]));
	return rows.map((r) => {
		const price = prices.get(r.row);
		return price === undefined ? r : { row: r.row, cells: { ...r.cells, price } };
	});
}

/** Sets one cell of one row (a seller's choice between ambiguous catalog matches, say). */
export function setCell(rows: readonly MappedRow[], row: number, key: string, value: string): MappedRow[] {
	return rows.map((r) => (r.row === row ? { row, cells: { ...r.cells, [key]: value } } : r));
}

export function chunk<T>(items: readonly T[], size = BATCH_SIZE): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Everything the file names, so "remove items not in file" keeps it (even rows with errors). */
export function keptByFile(rows: readonly MappedRow[]): { keepItemIds: string[]; keepSkus: string[] } {
	const ids = new Set<string>();
	const skus = new Set<string>();
	for (const { cells } of rows) {
		const id = (cells["item_id"] ?? "").trim();
		const sku = (cells["sku"] ?? "").trim();
		if (id) ids.add(id);
		if (sku) skus.add(sku);
	}
	return { keepItemIds: [...ids], keepSkus: [...skus] };
}

export interface RowOutcome {
	readonly row: number;
	readonly outcome: "created" | "updated" | "skipped" | "error";
	readonly itemId: string | null;
	readonly message: string;
}

/**
 * The results file (PLAN §3c.4): the seller's own file with `result` and `message`
 * columns added. Cells are formula-escaped, since they come back from a file.
 */
export function resultsCsv(table: Table, outcomes: ReadonlyMap<number, RowOutcome>): string {
	const [header = [], ...data] = table;
	const rows = [
		[...header, "result", "message"],
		...data.map((cells, index) => {
			const outcome = outcomes.get(index + 2);
			const padded = header.map((_, column) => cells[column] ?? "");
			return [...padded, outcome?.outcome ?? "", outcome?.message ?? ""];
		}),
	];
	return encodeCsv(rows.map((row) => row.map(escapeFormula)));
}
