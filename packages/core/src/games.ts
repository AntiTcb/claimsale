/**
 * The games registry (PLAN §3 "TCG catalog and item model", D59, D61). This is the
 * seed data for the `games` table: navigation, filters and the attribute schemas
 * (attributes.ts) all read from it. Adding a game is a row here plus, if it needs
 * game-specific single fields, an entry in attributes.ts.
 */

/** The TCGplayer-style condition scale every game uses, best first. */
export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONDITION_LABELS: Readonly<Record<Condition, string>> = {
	NM: "Near Mint",
	LP: "Lightly Played",
	MP: "Moderately Played",
	HP: "Heavily Played",
	DMG: "Damaged",
};

/** True when `condition` is at least as good as `minimum` (want lists, filters). */
export function conditionAtLeast(condition: Condition, minimum: Condition): boolean {
	return CONDITIONS.indexOf(condition) <= CONDITIONS.indexOf(minimum);
}

/** Language codes (BCP 47) and their display names. */
export const LANGUAGE_LABELS = {
	en: "English",
	ja: "Japanese",
	ko: "Korean",
	"zh-Hans": "Chinese (Simplified)",
	"zh-Hant": "Chinese (Traditional)",
	fr: "French",
	de: "German",
	it: "Italian",
	es: "Spanish",
	pt: "Portuguese",
	ru: "Russian",
	id: "Indonesian",
	th: "Thai",
} as const;
export type Language = keyof typeof LANGUAGE_LABELS;

/** Finishes a seller can pick; each game offers a subset. */
export const FINISH_LABELS = {
	normal: "Normal",
	"non-foil": "Non-foil",
	foil: "Foil",
	etched: "Etched foil",
	"non-holo": "Non-holo",
	holo: "Holo",
	"reverse-holo": "Reverse holo",
} as const;
export type Finish = keyof typeof FINISH_LABELS;

export interface Game {
	readonly slug: string;
	readonly name: string;
	readonly conditionScale: readonly Condition[];
	readonly finishes: readonly Finish[];
	readonly languages: readonly Language[];
	/**
	 * TCGplayer category ID, as TCGCSV lists it (`/tcgplayer/categories`). `null` when it
	 * isn't known yet; ingestion (WS-C) must fill these in before a game is enabled.
	 */
	readonly tcgplayerCategoryId: number | null;
	/** The "Product Line" name in TCGplayer seller exports (the TCGplayer import preset). */
	readonly tcgplayerProductLine: string;
	readonly enabled: boolean;
	readonly sortOrder: number;
}

const FOIL: readonly Finish[] = ["non-foil", "foil"];
const EN_JA: readonly Language[] = ["en", "ja"];

// TODO verify: every category ID against TCGCSV's /tcgplayer/categories before WS-C
// enables ingestion. MTG 1, YGO 2, Pokémon 3 are long-standing; the rest are from
// memory, and Riftbound / Gundam are recent additions.
export const GAMES: readonly Game[] = [
	{
		slug: "pokemon",
		name: "Pokémon",
		conditionScale: CONDITIONS,
		finishes: ["non-holo", "holo", "reverse-holo"],
		languages: ["en", "ja", "ko", "zh-Hant", "zh-Hans", "fr", "de", "it", "es", "pt", "id", "th"],
		tcgplayerCategoryId: 3,
		tcgplayerProductLine: "Pokemon",
		enabled: true,
		sortOrder: 10,
	},
	{
		slug: "yugioh",
		name: "Yu-Gi-Oh!",
		conditionScale: CONDITIONS,
		// Foil treatment is part of the YGO rarity (Secret, Ultra…), so there is no finish choice.
		finishes: ["normal"],
		languages: ["en", "ja", "ko", "fr", "de", "it", "es", "pt"],
		tcgplayerCategoryId: 2,
		tcgplayerProductLine: "YuGiOh",
		enabled: true,
		sortOrder: 20,
	},
	{
		slug: "mtg",
		name: "Magic: The Gathering",
		conditionScale: CONDITIONS,
		finishes: ["non-foil", "foil", "etched"],
		languages: ["en", "ja", "de", "fr", "it", "es", "pt", "ru", "ko", "zh-Hans", "zh-Hant"],
		tcgplayerCategoryId: 1,
		tcgplayerProductLine: "Magic",
		enabled: true,
		sortOrder: 30,
	},
	{
		slug: "riftbound",
		name: "Riftbound",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: ["en", "zh-Hans"],
		tcgplayerCategoryId: 89, // TODO verify
		tcgplayerProductLine: "Riftbound: League of Legends Trading Card Game", // TODO verify
		enabled: true,
		sortOrder: 40,
	},
	{
		slug: "one-piece",
		name: "One Piece Card Game",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: ["en", "ja"],
		tcgplayerCategoryId: 68, // TODO verify
		tcgplayerProductLine: "One Piece Card Game",
		enabled: true,
		sortOrder: 50,
	},
	{
		slug: "lorcana",
		name: "Disney Lorcana",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: ["en", "fr", "de", "it", "ja"],
		tcgplayerCategoryId: 71, // TODO verify
		tcgplayerProductLine: "Lorcana TCG",
		enabled: true,
		sortOrder: 60,
	},
	{
		slug: "flesh-and-blood",
		name: "Flesh and Blood",
		conditionScale: CONDITIONS,
		finishes: ["non-foil", "foil"],
		languages: ["en", "fr", "de", "it", "es", "ja"],
		tcgplayerCategoryId: 62, // TODO verify
		tcgplayerProductLine: "Flesh and Blood TCG",
		enabled: true,
		sortOrder: 70,
	},
	{
		slug: "star-wars-unlimited",
		name: "Star Wars: Unlimited",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: ["en", "fr", "de", "it", "es"],
		tcgplayerCategoryId: 79, // TODO verify
		tcgplayerProductLine: "Star Wars: Unlimited",
		enabled: true,
		sortOrder: 80,
	},
	{
		slug: "digimon",
		name: "Digimon Card Game",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: EN_JA,
		tcgplayerCategoryId: 63, // TODO verify
		tcgplayerProductLine: "Digimon Card Game",
		enabled: true,
		sortOrder: 90,
	},
	{
		slug: "gundam",
		name: "Gundam Card Game",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: EN_JA,
		tcgplayerCategoryId: null, // TODO verify (recent addition to TCGCSV)
		tcgplayerProductLine: "Gundam Card Game",
		enabled: true,
		sortOrder: 100,
	},
	{
		slug: "dragon-ball-fusion-world",
		name: "Dragon Ball Super: Fusion World",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: EN_JA,
		tcgplayerCategoryId: 80, // TODO verify
		tcgplayerProductLine: "Dragon Ball Super Fusion World",
		enabled: true,
		sortOrder: 110,
	},
	{
		slug: "union-arena",
		name: "Union Arena",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: EN_JA,
		tcgplayerCategoryId: 81, // TODO verify
		tcgplayerProductLine: "Union Arena",
		enabled: true,
		sortOrder: 120,
	},
	{
		slug: "weiss-schwarz",
		name: "Weiss Schwarz",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: EN_JA,
		tcgplayerCategoryId: 20, // TODO verify
		tcgplayerProductLine: "Weiss Schwarz",
		enabled: true,
		sortOrder: 130,
	},
	{
		slug: "cardfight-vanguard",
		name: "Cardfight!! Vanguard",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: EN_JA,
		tcgplayerCategoryId: 16, // TODO verify
		tcgplayerProductLine: "Cardfight Vanguard",
		enabled: true,
		sortOrder: 140,
	},
	{
		slug: "sorcery",
		name: "Sorcery: Contested Realm",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: ["en"],
		tcgplayerCategoryId: 77, // TODO verify
		tcgplayerProductLine: "Sorcery Contested Realm",
		enabled: true,
		sortOrder: 150,
	},
	{
		slug: "grand-archive",
		name: "Grand Archive",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: EN_JA,
		tcgplayerCategoryId: 74, // TODO verify
		tcgplayerProductLine: "Grand Archive TCG",
		enabled: true,
		sortOrder: 160,
	},
	{
		slug: "final-fantasy",
		name: "Final Fantasy TCG",
		conditionScale: CONDITIONS,
		finishes: FOIL,
		languages: ["en", "ja", "fr", "de", "it", "es"],
		tcgplayerCategoryId: 24, // TODO verify
		tcgplayerProductLine: "Final Fantasy TCG",
		enabled: true,
		sortOrder: 170,
	},
];

const BY_SLUG: ReadonlyMap<string, Game> = new Map(GAMES.map((game) => [game.slug, game]));

export function gameBySlug(slug: string): Game | undefined {
	return BY_SLUG.get(slug);
}

/** Enabled games in display order. */
export function enabledGames(): Game[] {
	return GAMES.filter((game) => game.enabled).toSorted((a, b) => a.sortOrder - b.sortOrder);
}

const normalizeName = (value: string) =>
	value
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");

const ALIASES: Readonly<Record<string, string>> = {
	ygo: "yugioh",
	magicthegathering: "mtg",
	ptcg: "pokemon",
	optcg: "one-piece",
	fab: "flesh-and-blood",
	swu: "star-wars-unlimited",
};

/**
 * Resolves a game from what a seller or another app wrote: our slug, the display name,
 * a common abbreviation, or a TCGplayer product line ("YuGiOh", "Magic"). Case,
 * accents and punctuation are ignored.
 */
export function resolveGame(value: string): Game | undefined {
	const key = normalizeName(value);
	if (key === "") return undefined;
	const alias = ALIASES[key];
	if (alias !== undefined) return gameBySlug(alias);
	return GAMES.find(
		(game) =>
			normalizeName(game.slug) === key ||
			normalizeName(game.name) === key ||
			normalizeName(game.tcgplayerProductLine) === key,
	);
}
