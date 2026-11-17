import { resolveGame } from "../games.ts";
import { isBlankRow } from "./csv.ts";
import { ATTRIBUTE_KEYS, CORE_KEYS, EXPORT_ONLY_COLUMNS } from "./columns.ts";
import type { MappedRow } from "./import.ts";

/**
 * Column mapping (PLAN §3c.1): turn a file's headers into our fields, either by
 * matching names, by a named preset for another app's export, or by the mapping the
 * seller picked (remembered per seller by the app).
 */

/** header → our field, or null to ignore the column. */
export type ColumnMapping = Readonly<Record<string, string | null>>;

/** Every field a column can map to. */
export const IMPORT_FIELDS: ReadonlySet<string> = new Set([...CORE_KEYS, "item_id", ...ATTRIBUTE_KEYS]);

const IGNORED: ReadonlySet<string> = new Set([
	...EXPORT_ONLY_COLUMNS.filter((c) => c !== "item_id"),
	"template_version",
]);

const SYNONYMS: Readonly<Record<string, string>> = {
	item_type: "kind",
	type: "kind",
	card_name: "name",
	product_name: "name",
	set: "set_code",
	collector_number: "number",
	card_number: "number",
	qty: "quantity",
	count: "quantity",
	tcgplayer_id: "tcgplayer_product_id",
	product_id: "tcgplayer_product_id",
	image: "photos",
	images: "photos",
	photo: "photos",
	asking_price: "price",
	cert: "cert_number",
	certification_number: "cert_number",
	foil: "finish",
	printing: "finish",
};

export const normalizeHeader = (header: string): string =>
	header
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");

/**
 * Maps headers to fields by name (our own templates and exports map exactly).
 * Headers that match nothing are listed in `unmapped` for the seller to map by hand;
 * a field is only ever mapped once (the first header wins).
 */
export function autoMapColumns(headers: readonly string[]): { mapping: ColumnMapping; unmapped: string[] } {
	const mapping: Record<string, string | null> = {};
	const unmapped: string[] = [];
	const used = new Set<string>();
	for (const header of headers) {
		const key = normalizeHeader(header);
		const field = IMPORT_FIELDS.has(key) ? key : SYNONYMS[key];
		if (IGNORED.has(key)) mapping[header] = null;
		else if (field !== undefined && !used.has(field)) {
			mapping[header] = field;
			used.add(field);
		} else {
			mapping[header] = null;
			if (key !== "") unmapped.push(header);
		}
	}
	return { mapping, unmapped };
}

/** Applies a mapping to a parsed table (header row first) and drops blank rows. */
export function mapRows(table: readonly (readonly string[])[], mapping: ColumnMapping): MappedRow[] {
	const [headers = [], ...data] = table;
	const out: MappedRow[] = [];
	data.forEach((cells, index) => {
		if (isBlankRow(cells)) return;
		const mapped: Record<string, string> = {};
		headers.forEach((header, column) => {
			const field = mapping[header];
			if (field != null) mapped[field] = cells[column] ?? "";
		});
		out.push({ row: index + 2, cells: mapped });
	});
	return out;
}

// ---------------------------------------------------------------------------
// Presets (D61): TCGplayer and ManaBox exports at launch

export interface ImportPreset {
	readonly id: "tcgplayer" | "manabox";
	readonly name: string;
	/** Whether a file's headers look like this app's export. */
	readonly detect: (headers: readonly string[]) => boolean;
	/** Turns one row into our fields, or null to skip it. `get` reads a cell by header (any case). */
	readonly mapRow: (get: (header: string) => string) => Record<string, string> | null;
}

const has = (headers: readonly string[], ...names: string[]) => {
	const set = new Set(headers.map(normalizeHeader));
	return names.every((name) => set.has(normalizeHeader(name)));
};

const CONDITION_PREFIXES = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];

/**
 * TCGplayer's Condition column folds the printing in: "Near Mint", "Lightly Played
 * Foil", "Near Mint Reverse Holofoil", "Near Mint 1st Edition", "Unopened" (sealed).
 */
function splitTcgplayerCondition(value: string, gameSlug: string | null) {
	const text = value.trim();
	if (/^unopened$/i.test(text)) return { kind: "sealed" as const, condition: "", finish: "", edition: "" };
	const prefix = CONDITION_PREFIXES.find((p) => text.toLowerCase().startsWith(p.toLowerCase()));
	const rest = prefix ? text.slice(prefix.length).trim() : "";
	let edition = "";
	let printing = rest;
	const editionMatch = /\b(1st Edition|Unlimited|Limited)\b/i.exec(rest);
	if (editionMatch) {
		edition = editionMatch[1]!;
		printing = rest.replace(editionMatch[0], "").trim();
	}
	let finish = "";
	if (/^reverse holofoil$/i.test(printing)) finish = "reverse-holo";
	else if (/^(holofoil|foil)$/i.test(printing)) finish = gameSlug === "pokemon" ? "holo" : "foil";
	else if (printing === "" && gameSlug !== null && gameSlug !== "yugioh") {
		finish = gameSlug === "pokemon" ? "non-holo" : "non-foil";
	} else finish = printing;
	return { kind: "single" as const, condition: prefix ?? text, finish, edition };
}

/**
 * TCGplayer's seller inventory export ("Pricing" CSV). The market price columns are
 * deliberately ignored (D64); the seller's own marketplace price becomes the price.
 * Rows with a total quantity of 0 are skipped.
 * TODO verify: column names against a current export.
 */
export const TCGPLAYER_PRESET: ImportPreset = {
	id: "tcgplayer",
	name: "TCGplayer inventory export",
	detect: (headers) => has(headers, "TCGplayer Id", "Product Line", "Product Name"),
	mapRow: (get) => {
		const quantity = get("Total Quantity");
		if (quantity === "0") return null;
		const game = resolveGame(get("Product Line"));
		const split = splitTcgplayerCondition(get("Condition"), game?.slug ?? null);
		const out: Record<string, string> = {
			game: game?.slug ?? get("Product Line"),
			kind: split.kind,
			tcgplayer_product_id: get("TCGplayer Id"),
			name: get("Product Name"),
			set_name: get("Set Name"),
			price: get("TCG Marketplace Price"),
			quantity,
		};
		if (split.kind === "single") {
			out["number"] = get("Number");
			out["rarity"] = get("Rarity");
			out["condition"] = split.condition;
			out["finish"] = split.finish;
			if (split.edition !== "") out["edition"] = split.edition;
		}
		return out;
	},
};

/**
 * ManaBox's collection export (MTG). ManaBox has no asking price, so the seller sets
 * prices after the import (or with "N% of market"). Its "Purchase price" is what the
 * seller paid and is not imported.
 * TODO verify: column names and Foil / Condition values against a current export.
 */
export const MANABOX_PRESET: ImportPreset = {
	id: "manabox",
	name: "ManaBox collection export",
	detect: (headers) =>
		has(headers, "ManaBox ID") || has(headers, "Scryfall ID", "Collector number", "Set code"),
	mapRow: (get) => {
		const altered = get("Altered").toLowerCase();
		return {
			game: "mtg",
			kind: "single",
			name: get("Name"),
			set_code: get("Set code").toUpperCase(),
			set_name: get("Set name"),
			number: get("Collector number"),
			rarity: get("Rarity"),
			finish: get("Foil") || "non-foil",
			condition: get("Condition"),
			language: get("Language"),
			quantity: get("Quantity"),
			altered: altered === "true" || altered === "yes" ? "yes" : "",
		};
	},
};

export const IMPORT_PRESETS: readonly ImportPreset[] = [TCGPLAYER_PRESET, MANABOX_PRESET];

export function detectPreset(headers: readonly string[]): ImportPreset | null {
	return IMPORT_PRESETS.find((preset) => preset.detect(headers)) ?? null;
}

/** Runs a preset over a parsed table (header row first); skipped and blank rows are dropped. */
export function mapRowsWithPreset(table: readonly (readonly string[])[], preset: ImportPreset): MappedRow[] {
	const [headers = [], ...data] = table;
	const out: MappedRow[] = [];
	data.forEach((cells, index) => {
		if (isBlankRow(cells)) return;
		const byHeader = new Map<string, string>();
		headers.forEach((header, column) => {
			byHeader.set(normalizeHeader(header), cells[column] ?? "");
		});
		const mapped = preset.mapRow((header) => byHeader.get(normalizeHeader(header))?.trim() ?? "");
		if (mapped !== null) out.push({ row: index + 2, cells: mapped });
	});
	return out;
}
