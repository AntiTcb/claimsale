import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./schema.ts";

// ---------------------------------------------------------------------------
// TCG catalog (D59, D60, PLAN §6 "TCG catalog"). Filled nightly from TCGCSV by the
// engine (apps/engine/src/catalog). Timestamps are integer milliseconds.
//
// The FTS5 index `catalog_search` and its sync triggers live in the hand-written
// migration 0003_catalog_search.sql: Drizzle can't express virtual tables or triggers.
// Read it through `CATALOG_SEARCH_TABLE` and raw SQL.

const ms = (name: string) => integer(name, { mode: "number" });

/**
 * One row per game (D61). The launch games are seeded by the migration. Attribute
 * schemas and display data live in packages/core's games registry; `id` (the slug)
 * is the join key between the two.
 */
export const games = sqliteTable("games", {
	/** The game's slug, e.g. `pokemon` (PLAN routes `/g/[game]`). */
	id: text("id").primaryKey(),
	slug: text("slug").notNull().unique(),
	name: text("name").notNull(),
	/** JSON array of condition codes, best first. */
	conditionScale: text("condition_scale").notNull().default("[]"),
	/** JSON array of finish names. */
	finishes: text("finishes").notNull().default("[]"),
	/** JSON array of language codes. */
	languages: text("languages").notNull().default("[]"),
	tcgplayerCategoryId: integer("tcgplayer_category_id").unique(),
	/** Only enabled games are ingested and offered in pickers. */
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
	sortOrder: integer("sort_order").notNull().default(0),
	/** TCGCSV build (`last-updated.txt`) whose group list was last read for this game. */
	syncedBuild: text("synced_build"),
	syncedAt: ms("synced_at"),
});

export const catalogSets = sqliteTable(
	"catalog_sets",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		gameId: text("game_id")
			.notNull()
			.references(() => games.id),
		/** The set code / abbreviation (TCGplayer's `abbreviation`), e.g. `OGN`. */
		code: text("code"),
		name: text("name").notNull(),
		/** Release date as `YYYY-MM-DD`, from TCGplayer's `publishedOn`. */
		releaseDate: text("release_date"),
		tcgplayerGroupId: integer("tcgplayer_group_id").notNull().unique(),
		externalIds: text("external_ids").notNull().default("{}"),
		/** TCGCSV build whose products and prices were last ingested for this set. */
		syncedBuild: text("synced_build"),
		syncedAt: ms("synced_at"),
		updatedAt: ms("updated_at").notNull(),
	},
	(t) => [index("catalog_sets_game_sync").on(t.gameId, t.syncedBuild)],
);

export const catalogProducts = sqliteTable(
	"catalog_products",
	{
		/** Also the rowid of `catalog_search`. */
		id: integer("id").primaryKey({ autoIncrement: true }),
		gameId: text("game_id")
			.notNull()
			.references(() => games.id),
		setId: integer("set_id")
			.notNull()
			.references(() => catalogSets.id),
		kind: text("kind", { enum: ["single", "sealed"] }).notNull(),
		name: text("name").notNull(),
		/** Collector number as printed, e.g. `001/024`. */
		number: text("number"),
		rarity: text("rarity"),
		/** Sealed product type (booster box, bundle…); null for singles. */
		productType: text("product_type"),
		tcgplayerProductId: integer("tcgplayer_product_id").notNull().unique(),
		updatedAt: ms("updated_at").notNull(),
	},
	(t) => [
		index("catalog_products_set").on(t.setId),
		check("catalog_products_kind", sql`${t.kind} IN ('single', 'sealed')`),
	],
);

/**
 * The latest TCGplayer market price per product and subtype (D64). A seller-only
 * listing aid: never read in a buyer-facing response (`TCG-market-placeholder`).
 */
export const marketPrices = sqliteTable(
	"market_prices",
	{
		productId: integer("product_id")
			.notNull()
			.references(() => catalogProducts.id),
		/** As TCGCSV names it: `Normal`, `Foil`, `Holofoil`, `Reverse Holofoil`, `1st Edition`… */
		subtype: text("subtype").notNull(),
		/** Null when TCGplayer has no market price for this subtype. */
		marketCents: integer("market_cents"),
		/** When this value last changed (the TCGCSV build time, ms). */
		asOf: ms("as_of").notNull(),
	},
	(t) => [primaryKey({ columns: [t.productId, t.subtype] })],
);

/** Want lists (D61); matching and notifications come with milestone 9 (`TCG-want-list-notify`). */
export const wantListItems = sqliteTable(
	"want_list_items",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		productId: integer("product_id")
			.notNull()
			.references(() => catalogProducts.id),
		finish: text("finish"),
		maxPriceCents: integer("max_price_cents"),
		minCondition: text("min_condition"),
		language: text("language"),
		createdAt: ms("created_at").notNull(),
	},
	(t) => [index("want_list_items_user").on(t.userId), index("want_list_items_product").on(t.productId)],
);

/** The FTS5 table over product name, set name, set code and number (migration 0003). */
export const CATALOG_SEARCH_TABLE = "catalog_search";
