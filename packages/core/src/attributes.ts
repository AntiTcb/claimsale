import { Result as EffectResult, Schema, SchemaIssue } from "effect";
import { err, ok, type Result } from "./common.ts";
import { CONDITION_LABELS, FINISH_LABELS, LANGUAGE_LABELS, type Game } from "./games.ts";

/**
 * Item attributes per game × kind (PLAN §3 "TCG catalog and item model"). Each
 * game/kind pair is described once as a list of {@link FieldSpec}s; the Effect Schema
 * that validates forms, imports and the API, and the import template columns, are
 * both generated from that list, so they cannot drift apart.
 */

export const ITEM_KINDS = ["single", "graded", "sealed", "accessory", "lot"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_KIND_LABELS: Readonly<Record<ItemKind, string>> = {
	single: "Single",
	graded: "Graded single",
	sealed: "Sealed",
	accessory: "Accessory",
	lot: "Lot / bulk",
};

/** Accessories may name a game; every other kind needs one. */
export const gameRequired = (kind: ItemKind): boolean => kind !== "accessory";

/** `catalog` fields can be autofilled from TCGCSV (D60); everything else is the seller's. */
export type FieldSource = "catalog" | "seller";

interface FieldBase {
	/** The attribute key, also the import/export column header. */
	readonly key: string;
	readonly label: string;
	readonly required: boolean;
	readonly source: FieldSource;
	/** A value for the template's example row. */
	readonly example: string;
}

export type FieldSpec =
	| (FieldBase & {
			readonly type: "enum";
			readonly options: readonly string[];
			/** Display names per option; also accepted on import. */
			readonly labels?: Readonly<Record<string, string>>;
			/** Other spellings accepted on import, normalized (lowercase, alphanumerics only). */
			readonly aliases?: Readonly<Record<string, string>>;
	  })
	| (FieldBase & { readonly type: "text"; readonly maxLength: number; readonly pattern?: RegExp })
	| (FieldBase & { readonly type: "int"; readonly min: number; readonly max: number })
	| (FieldBase & { readonly type: "bool" });

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export interface FieldIssue {
	/** The attribute key or column; empty for issues about the whole row. */
	readonly field: string;
	readonly message: string;
}

// ---------------------------------------------------------------------------
// Field catalogue

const text = (
	key: string,
	label: string,
	maxLength: number,
	options: { required?: boolean; source?: FieldSource; example?: string; pattern?: RegExp } = {},
): FieldSpec => ({
	type: "text",
	key,
	label,
	maxLength,
	required: options.required ?? false,
	source: options.source ?? "seller",
	example: options.example ?? "",
	...(options.pattern ? { pattern: options.pattern } : {}),
});

const enumField = (
	key: string,
	label: string,
	options: readonly string[],
	extra: {
		required?: boolean;
		labels?: Readonly<Record<string, string>>;
		aliases?: Readonly<Record<string, string>>;
		example?: string;
	} = {},
): FieldSpec => ({
	type: "enum",
	key,
	label,
	options,
	required: extra.required ?? false,
	source: "seller",
	example: extra.example ?? options[0] ?? "",
	...(extra.labels ? { labels: extra.labels } : {}),
	...(extra.aliases ? { aliases: extra.aliases } : {}),
});

const bool = (key: string, label: string, example = "no"): FieldSpec => ({
	type: "bool",
	key,
	label,
	required: false,
	source: "seller",
	example,
});

/**
 * Condition spellings from other apps. TCGplayer uses the same scale; ManaBox and
 * Cardmarket use NM / EX / GD / LP / PL / PO, mapped to the closest TCGplayer grade.
 * TODO verify: ManaBox's exact export values.
 */
const CONDITION_ALIASES: Readonly<Record<string, string>> = {
	mint: "NM",
	nearmint: "NM",
	excellent: "LP",
	ex: "LP",
	lightlyplayed: "LP",
	lightplayed: "LP",
	slightlyplayed: "LP",
	good: "MP",
	gd: "MP",
	moderatelyplayed: "MP",
	played: "HP",
	pl: "HP",
	heavilyplayed: "HP",
	poor: "DMG",
	po: "DMG",
	damaged: "DMG",
};

const FINISH_ALIASES: Readonly<Record<string, string>> = {
	nonfoil: "non-foil",
	normal: "non-foil",
	regular: "non-foil",
	foil: "foil",
	holofoil: "holo",
	holo: "holo",
	reverseholofoil: "reverse-holo",
	reverseholo: "reverse-holo",
	nonholo: "non-holo",
	etchedfoil: "etched",
};

const condition = (game: Game) =>
	enumField("condition", "Condition", game.conditionScale, {
		required: true,
		labels: CONDITION_LABELS,
		aliases: CONDITION_ALIASES,
	});
const language = (game: Game) =>
	enumField("language", "Language", game.languages, { labels: LANGUAGE_LABELS, example: "en" });
const finish = (game: Game) => {
	const options = game.finishes;
	// Only keep aliases that land on one of this game's finishes ("normal" means non-foil
	// for MTG, but YGO's only finish is "normal").
	const aliases = Object.fromEntries(
		Object.entries(FINISH_ALIASES).filter(([, to]) => (options as readonly string[]).includes(to)),
	);
	return enumField("finish", "Finish", options, { labels: FINISH_LABELS, aliases });
};

/** Catalog-filled fields for cards and sealed product (TCG-autofill-only). */
const catalogFields = (kind: "card" | "sealed"): FieldSpec[] => [
	text("name", kind === "card" ? "Card name" : "Product name", 200, {
		required: true,
		source: "catalog",
		example: kind === "card" ? "Charizard ex" : "Obsidian Flames Booster Box",
	}),
	text("set_code", "Set code", 32, { source: "catalog", example: "OBF" }),
	text("set_name", "Set name", 120, { source: "catalog", example: "Obsidian Flames" }),
	...(kind === "card"
		? [
				text("number", "Collector number", 32, { source: "catalog", example: "125/197" }),
				text("rarity", "Rarity", 60, { source: "catalog", example: "Double Rare" }),
			]
		: [text("product_type", "Product type", 60, { source: "catalog", example: "Booster Box" })]),
	{
		type: "int",
		key: "tcgplayer_product_id",
		label: "TCGplayer product ID",
		min: 1,
		max: 2_147_483_647,
		required: false,
		source: "catalog",
		example: "",
	},
];

/** Game-specific single details (PLAN §3 table). */
function gameDetails(game: Game): FieldSpec[] {
	switch (game.slug) {
		case "yugioh":
			return [
				enumField("edition", "Edition", ["1st", "unlimited", "limited"], {
					labels: { "1st": "1st Edition", unlimited: "Unlimited", limited: "Limited" },
					aliases: { "1stedition": "1st", first: "1st", firstedition: "1st" },
				}),
				text("print_region", "Print region", 40, { example: "TCG (NA)" }),
			];
		case "pokemon":
			return [
				enumField("edition", "Edition", ["unlimited", "1st-edition", "shadowless"], {
					labels: { unlimited: "Unlimited", "1st-edition": "1st Edition", shadowless: "Shadowless" },
					aliases: { "1st": "1st-edition", "1stedition": "1st-edition", firstedition: "1st-edition" },
				}),
				text("promo_stamp", "Promo stamp", 80),
			];
		case "mtg":
			return [
				enumField("treatment", "Treatment", [
					"normal",
					"showcase",
					"borderless",
					"extended-art",
					"retro-frame",
					"full-art",
					"other",
				]),
			];
		case "riftbound":
			return [enumField("variant", "Variant", ["standard", "alt-art", "signature", "overnumbered"])];
		default:
			return [];
	}
}

/** Graders (PLAN §3) and their public certificate lookup pages. */
export const GRADERS = ["PSA", "BGS", "CGC", "SGC", "TAG", "ACE", "other"] as const;
export type Grader = (typeof GRADERS)[number];

/** 10, 9.5 … 1, plus "Authentic" (graded as genuine, no number). */
export const GRADES: readonly string[] = [
	...Array.from({ length: 19 }, (_, i) => String(10 - i / 2)),
	"Authentic",
];

const CERT_NUMBER = /^[A-Za-z0-9-]{4,32}$/;

/**
 * The grader's own verification page for a cert number, or null when we don't know
 * one. TODO verify: URL formats against each grader's site before showing links.
 */
export function certificateUrl(grader: Grader, certNumber: string): string | null {
	if (!CERT_NUMBER.test(certNumber)) return null;
	const cert = encodeURIComponent(certNumber);
	switch (grader) {
		case "PSA":
			return `https://www.psacard.com/cert/${cert}`;
		case "BGS":
			return `https://www.beckett.com/grading/card-lookup?item_type=BGS&item_id=${cert}`;
		case "CGC":
			return `https://www.cgccards.com/certlookup/${cert}/`;
		case "SGC":
			return `https://gosgc.com/cert-code-lookup/${cert}`;
		default:
			return null;
	}
}

export const ACCESSORY_TYPES = [
	"playmat",
	"sleeves",
	"deck-box",
	"binder",
	"storage",
	"dice-counters",
	"other",
] as const;

function buildFields(kind: ItemKind, game: Game | null): FieldSpec[] {
	switch (kind) {
		case "single":
		case "graded": {
			if (game === null) throw new Error(`${kind} items need a game`);
			const shared = [...catalogFields("card"), language(game), finish(game), ...gameDetails(game)];
			if (kind === "single") return [...shared, condition(game), bool("altered", "Altered art")];
			return [
				...shared,
				enumField("grader", "Grader", GRADERS, { required: true, example: "PSA" }),
				enumField("grade", "Grade", GRADES, { required: true, example: "10" }),
				text("subgrades", "Subgrades", 60, { example: "" }),
				enumField(
					"autograph_grade",
					"Autograph grade",
					GRADES.slice(0, -1).filter((g) => !g.includes(".")),
				),
				text("cert_number", "Cert number", 32, { required: true, pattern: CERT_NUMBER, example: "12345678" }),
			];
		}
		case "sealed":
			if (game === null) throw new Error("sealed items need a game");
			return [
				...catalogFields("sealed"),
				language(game),
				text("seal_notes", "Seal notes", 500),
				bool("repack", "Repack (not factory sealed)"),
			];
		case "accessory":
			return [
				enumField("accessory_type", "Accessory type", ACCESSORY_TYPES, {
					required: true,
					example: "playmat",
				}),
				text("brand", "Brand", 80, { example: "Ultra PRO" }),
				enumField("condition", "Condition", ["new", "like-new", "used"], {
					required: true,
					labels: { new: "New", "like-new": "Like new", used: "Used" },
				}),
			];
		default: // "lot"
			if (game === null) throw new Error("lots need a game");
			return [
				{
					type: "int",
					key: "card_count",
					label: "Card count",
					min: 1,
					max: 1_000_000,
					required: true,
					source: "seller",
					example: "100",
				},
				text("card_list", "Card list", 10_000),
			];
	}
}

// ---------------------------------------------------------------------------
// Schemas

function fieldSchema(spec: FieldSpec): Schema.Top {
	switch (spec.type) {
		case "enum":
			return Schema.Literals(spec.options);
		case "text": {
			// Trimmed, so a value survives an export → import round trip unchanged.
			const base = Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(spec.maxLength),
				Schema.isTrimmed(),
			);
			return spec.pattern ? base.check(Schema.isPattern(spec.pattern)) : base;
		}
		case "int":
			return Schema.Int.check(Schema.isBetween({ minimum: spec.min, maximum: spec.max }));
		default: // "bool"
			return Schema.Boolean;
	}
}

interface Compiled {
	readonly fields: readonly FieldSpec[];
	readonly byKey: ReadonlyMap<string, FieldSpec>;
	readonly decode: (input: unknown) => EffectResult.Result<unknown, Schema.SchemaError>;
	readonly schema: Schema.Top;
}

const compiled = new Map<string, Compiled>();

function compile(kind: ItemKind, game: Game | null): Compiled {
	// Accessories don't depend on the game.
	const cacheKey = `${kind}:${kind === "accessory" ? "" : (game?.slug ?? "")}`;
	const hit = compiled.get(cacheKey);
	if (hit) return hit;
	const fields = buildFields(kind, game);
	const struct: Record<string, Schema.Top> = {};
	for (const spec of fields) {
		const schema = fieldSchema(spec);
		struct[spec.key] = spec.required ? schema : Schema.optionalKey(schema);
	}
	const schema = Schema.Struct(struct);
	// The fields are only built-in schemas, so decoding needs no services.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	const decode = Schema.decodeUnknownResult(schema as unknown as Schema.Codec<unknown>);
	const entry: Compiled = {
		fields,
		byKey: new Map(fields.map((spec) => [spec.key, spec])),
		decode: (input) => decode(input, { errors: "all", onExcessProperty: "error" }),
		schema,
	};
	compiled.set(cacheKey, entry);
	return entry;
}

/** The attribute fields for a kind (and game; `null` only for accessories). */
export function attributeFields(kind: ItemKind, game: Game | null): readonly FieldSpec[] {
	return compile(kind, game).fields;
}

/** The Effect Schema for a kind's attributes, for forms and the API. */
export function attributeSchema(kind: ItemKind, game: Game | null): Schema.Top {
	return compile(kind, game).schema;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function describe(spec: FieldSpec | undefined, fallback: string): string {
	if (spec === undefined) return fallback;
	switch (spec.type) {
		case "enum":
			return `${spec.label} must be one of: ${spec.options.join(", ")}`;
		case "text":
			return spec.pattern
				? `${spec.label} must be 4–${spec.maxLength} letters, digits or dashes`
				: `${spec.label} must be 1–${spec.maxLength} characters, without leading or trailing spaces`;
		case "int":
			return `${spec.label} must be a whole number from ${spec.min} to ${spec.max}`;
		default: // "bool"
			return `${spec.label} must be yes or no`;
	}
}

/**
 * Validates an item's attributes against its game + kind schema.
 *
 * @spec TCG-attribute-schema
 *
 * Unknown keys are rejected, so a field from another game or kind never sneaks into
 * an item. Every problem is reported, keyed by attribute.
 */
export function validateAttributes(
	kind: ItemKind,
	game: Game | null,
	input: unknown,
): Result<Attributes, readonly FieldIssue[]> {
	if (game === null && gameRequired(kind)) {
		return err([{ field: "game", message: `A ${ITEM_KIND_LABELS[kind].toLowerCase()} needs a game` }]);
	}
	const { decode, byKey } = compile(kind, game);
	const result = decode(input);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every field schema decodes to an AttributeValue
	if (EffectResult.isSuccess(result)) return ok(result.success as Attributes);
	const issues = formatIssues(result.failure.issue).issues.map((issue): FieldIssue => {
		const head = issue.path?.[0];
		const key = typeof head === "string" ? head : "";
		const spec = byKey.get(key);
		if (issue.message === "Missing key") return { field: key, message: `${spec?.label ?? key} is required` };
		if (spec === undefined && key !== "") {
			return { field: key, message: `"${key}" is not a field for this game and kind` };
		}
		return { field: key, message: describe(spec, issue.message) };
	});
	return err(issues);
}

// ---------------------------------------------------------------------------
// String coercion (imports) and formatting (exports)

const normalizeToken = (value: string) =>
	value
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");

const TRUE = new Set(["yes", "y", "true", "1", "x"]);
const FALSE = new Set(["no", "n", "false", "0"]);

/** Turns one imported cell into a typed value; unparseable input is left for the schema to reject. */
export function coerceAttribute(spec: FieldSpec, raw: string): AttributeValue | undefined {
	const value = raw.trim();
	if (value === "") return undefined;
	switch (spec.type) {
		case "text":
			return value;
		case "int":
			return /^-?\d+$/.test(value) ? Number(value) : value;
		case "bool": {
			const key = value.toLowerCase();
			if (TRUE.has(key)) return true;
			if (FALSE.has(key)) return false;
			return value;
		}
		default: {
			// "enum"
			if (spec.options.includes(value)) return value;
			const token = normalizeToken(value);
			const direct = spec.options.find((option) => normalizeToken(option) === token);
			if (direct !== undefined) return direct;
			const byLabel = spec.options.find((option) => {
				const label = spec.labels?.[option];
				return label !== undefined && normalizeToken(label) === token;
			});
			return byLabel ?? spec.aliases?.[token] ?? value;
		}
	}
}

/** Coerces the attribute cells of a row (keyed by attribute) for {@link validateAttributes}. */
export function coerceAttributes(
	fields: readonly FieldSpec[],
	raw: Readonly<Record<string, string | undefined>>,
): Record<string, AttributeValue> {
	const out: Record<string, AttributeValue> = {};
	for (const spec of fields) {
		const cell = raw[spec.key];
		if (cell === undefined) continue;
		const value = coerceAttribute(spec, cell);
		if (value !== undefined) out[spec.key] = value;
	}
	return out;
}

/** The cell text for an attribute value; {@link coerceAttribute} reads it back unchanged. */
export function formatAttribute(value: AttributeValue | undefined): string {
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "yes" : "no";
	return String(value);
}
