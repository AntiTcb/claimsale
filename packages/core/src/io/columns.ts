import { attributeFields, ITEM_KINDS, type FieldSpec, type ItemKind } from "../attributes.ts";
import { GAMES, type Game } from "../games.ts";

/**
 * Import / export columns (PLAN §3c.1). The core columns are the same for every item;
 * the attribute columns come from the game × kind schema (attributes.ts), so the
 * templates, the exports and the importer always agree.
 */

/** Bumped whenever a template column changes meaning. */
export const TEMPLATE_VERSION = 1;

export interface Column {
	readonly header: string;
	readonly required: boolean;
	readonly description: string;
	readonly example: string;
}

/** Columns every item row has, in template order. */
export const CORE_COLUMNS: readonly Column[] = [
	{
		header: "sku",
		required: false,
		description: "Your own ID; re-importing updates the item with this SKU",
		example: "CHZ-001",
	},
	{
		header: "game",
		required: true,
		description: "Game slug (blank only for accessories)",
		example: "pokemon",
	},
	{
		header: "kind",
		required: true,
		description: "single, graded, sealed, accessory or lot",
		example: "single",
	},
	{
		header: "title",
		required: false,
		description: "Listing title (defaults to the card or product name)",
		example: "",
	},
	{ header: "description", required: false, description: "Anything a buyer should know", example: "" },
	{ header: "price", required: true, description: "Asking price in USD, e.g. 12.40", example: "12.40" },
	{ header: "quantity", required: false, description: "Units available (default 1)", example: "1" },
	{ header: "offers", required: false, description: "off, on, or min (Pro: hidden minimum)", example: "off" },
	{
		header: "min_offer",
		required: false,
		description: "Hidden minimum offer when offers is min (Pro)",
		example: "",
	},
	{
		header: "shipping_override",
		required: false,
		description: "Shipping price for this item, e.g. oversized",
		example: "",
	},
	{
		header: "photos",
		required: false,
		description: "File names in the photo ZIP, separated by ;",
		example: "charizard-front.jpg;charizard-back.jpg",
	},
];

/** Columns only exports carry; the importer reads `item_id` and ignores the rest. */
export const EXPORT_ONLY_COLUMNS = ["item_id", "status", "winner_handle", "final_price"] as const;

export const CORE_KEYS: ReadonlySet<string> = new Set(CORE_COLUMNS.map((column) => column.header));

/** Every attribute key any game × kind can have, in a stable order. */
export const ATTRIBUTE_KEYS: readonly string[] = (() => {
	const keys = new Set<string>();
	for (const kind of ITEM_KINDS) {
		for (const game of GAMES) for (const spec of attributeFields(kind, game)) keys.add(spec.key);
	}
	return [...keys];
})();

const attributeColumn = (spec: FieldSpec): Column => ({
	header: spec.key,
	required: spec.required,
	description:
		spec.type === "enum"
			? `${spec.label}: ${spec.options.join(", ")}`
			: spec.type === "bool"
				? `${spec.label}: yes or no`
				: spec.type === "int"
					? `${spec.label}: a whole number`
					: spec.source === "catalog"
						? `${spec.label} (filled in from the catalog when it matches)`
						: spec.label,
	example: spec.example,
});

/**
 * The template's columns for one game and kind.
 *
 * @spec TCG-attribute-schema
 */
export function templateColumns(kind: ItemKind, game: Game | null): Column[] {
	return [
		...CORE_COLUMNS,
		...attributeFields(kind, game).map(attributeColumn),
		{
			header: "template_version",
			required: false,
			description: "Leave as is",
			example: String(TEMPLATE_VERSION),
		},
	];
}

/** The template file's rows: the header and one example row (PLAN §3c.1). */
export function templateRows(kind: ItemKind, game: Game | null): string[][] {
	const columns = templateColumns(kind, game);
	const example = columns.map((column) => {
		if (column.header === "game") return game?.slug ?? "";
		if (column.header === "kind") return kind;
		// Accessories and lots have no catalog name to fall back on.
		if (column.header === "title" && (kind === "accessory" || kind === "lot")) return "Example listing title";
		return column.example;
	});
	return [columns.map((column) => column.header), example];
}
