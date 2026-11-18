import {
	DISCOVERABLE_STATUSES,
	ITEMS_PER_PAGE,
	searchTerms,
	type ItemFilters,
	type Millis,
} from "@claimsale/core";
import { sql, type Db, type SQL } from "@claimsale/db";

/**
 * Discovery reads (WS-L): browse, game pages, search and "who has this card?". Every
 * query starts from {@link DISCOVERABLE}, so nothing here can list a sale that isn't
 * public and scheduled or live.
 */

/**
 * @spec DISC-public-only — the one WHERE clause every discovery query uses: public,
 * scheduled or live sales of sellers who aren't banned, and items that aren't withdrawn.
 */
const DISCOVERABLE = sql`s.visibility = 'public'
	AND s.status IN (SELECT value FROM json_each(${JSON.stringify(DISCOVERABLE_STATUSES)}))
	AND u.banned_at IS NULL`;
const LISTED_ITEM = sql`i.state != 'withdrawn'`;

/** A sale as browse and the landing page show it. */
export interface SaleCard {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly status: "scheduled" | "live";
	readonly liveAt: Millis | null;
	readonly closesAt: Millis | null;
	readonly sellerHandle: string | null;
	readonly sellerName: string;
	readonly itemCount: number;
	/** The first approved photo of the sale's first item. */
	readonly imageId: string | null;
}

interface SaleRow {
	id: string;
	slug: string;
	title: string;
	status: "scheduled" | "live";
	live_at: number | null;
	closes_at: number | null;
	seller_handle: string | null;
	seller_name: string;
	item_count: number;
	image_id: string | null;
}

const SALE_COLUMNS = sql`s.id, s.slug, s.title, s.status, s.live_at, s.closes_at,
	u.handle AS seller_handle, u.display_name AS seller_name,
	(SELECT count(*) FROM items i WHERE i.sale_id = s.id AND ${LISTED_ITEM}) AS item_count,
	(SELECT im.id FROM item_images im JOIN items fi ON fi.id = im.item_id
		WHERE fi.sale_id = s.id AND im.status = 'approved'
		ORDER BY fi.sort_order, im.sort_order, im.created_at LIMIT 1) AS image_id`;

const toSaleCard = (r: SaleRow): SaleCard => ({
	id: r.id,
	slug: r.slug,
	title: r.title,
	status: r.status,
	liveAt: r.live_at,
	closesAt: r.closes_at,
	sellerHandle: r.seller_handle,
	sellerName: r.seller_name,
	itemCount: r.item_count,
	imageId: r.image_id,
});

export type SaleOrder = "live" | "upcoming";

/**
 * Discoverable sales: live ones closing soonest first, or upcoming ones going live
 * soonest first. With `gameId`, only sales with an item of that game.
 */
export async function listSales(
	db: Db,
	options: { order: SaleOrder; gameId?: string; sellerIds?: readonly string[]; limit?: number },
): Promise<SaleCard[]> {
	const where: SQL[] = [DISCOVERABLE];
	where.push(options.order === "live" ? sql`s.status = 'live'` : sql`s.status = 'scheduled'`);
	if (options.gameId)
		where.push(
			sql`EXISTS (SELECT 1 FROM items i WHERE i.sale_id = s.id AND i.game_id = ${options.gameId} AND ${LISTED_ITEM})`,
		);
	if (options.sellerIds)
		where.push(sql`s.seller_id IN (SELECT value FROM json_each(${JSON.stringify(options.sellerIds)}))`);
	const order =
		options.order === "live"
			? sql`ORDER BY s.closes_at IS NULL, s.closes_at, s.id`
			: sql`ORDER BY s.live_at IS NULL, s.live_at, s.id`;
	const rows = await db.all<SaleRow>(
		sql`SELECT ${SALE_COLUMNS} FROM sales s JOIN users u ON u.id = s.seller_id
			WHERE ${sql.join(where, sql` AND `)} ${order} LIMIT ${options.limit ?? 24}`,
	);
	return rows.map(toSaleCard);
}

/** An item as game pages, search and "who has this card?" show it: buyer-facing fields only. */
export interface ItemCard {
	readonly id: string;
	readonly title: string;
	readonly priceCents: number;
	readonly quantity: number;
	readonly unitsWon: number;
	readonly state: string;
	readonly kind: string;
	readonly condition: string | null;
	readonly gameId: string;
	readonly saleSlug: string;
	readonly saleTitle: string;
	readonly saleStatus: "scheduled" | "live";
	readonly liveAt: Millis | null;
	readonly closesAt: Millis | null;
	readonly sellerHandle: string | null;
	readonly imageId: string | null;
}

interface ItemRow {
	id: string;
	title: string;
	price_cents: number;
	quantity: number;
	units_won: number;
	state: string;
	kind: string;
	condition: string | null;
	game_id: string;
	sale_slug: string;
	sale_title: string;
	sale_status: "scheduled" | "live";
	live_at: number | null;
	closes_at: number | null;
	seller_handle: string | null;
	image_id: string | null;
}

/** Never `min_offer_cents`, `sku` or anything from `market_prices` (DISC-public-only). */
const ITEM_COLUMNS = sql`i.id, i.title, i.price_cents, i.quantity, i.units_won, i.state, i.kind,
	i.condition, i.game_id, s.slug AS sale_slug, s.title AS sale_title, s.status AS sale_status,
	s.live_at, s.closes_at, u.handle AS seller_handle,
	(SELECT im.id FROM item_images im WHERE im.item_id = i.id AND im.status = 'approved'
		ORDER BY im.sort_order, im.created_at LIMIT 1) AS image_id`;
const ITEM_FROM = sql`items i JOIN sales s ON s.id = i.sale_id JOIN users u ON u.id = s.seller_id`;

const toItemCard = (r: ItemRow): ItemCard => ({
	id: r.id,
	title: r.title,
	priceCents: r.price_cents,
	quantity: r.quantity,
	unitsWon: r.units_won,
	state: r.state,
	kind: r.kind,
	condition: r.condition,
	gameId: r.game_id,
	saleSlug: r.sale_slug,
	saleTitle: r.sale_title,
	saleStatus: r.sale_status,
	liveAt: r.live_at,
	closesAt: r.closes_at,
	sellerHandle: r.seller_handle,
	imageId: r.image_id,
});

const attribute = (key: string, value: string) =>
	sql`EXISTS (SELECT 1 FROM item_attributes a WHERE a.item_id = i.id AND a.key = ${key} AND a.value_text = ${value})`;

function filterClauses(filters: ItemFilters): SQL[] {
	const where: SQL[] = [];
	if (filters.kind) where.push(sql`i.kind = ${filters.kind}`);
	if (filters.conditions.length > 0)
		where.push(sql`i.condition IN (SELECT value FROM json_each(${JSON.stringify(filters.conditions)}))`);
	if (filters.set) where.push(attribute("set_name", filters.set));
	if (filters.rarity) where.push(attribute("rarity", filters.rarity));
	if (filters.language) where.push(attribute("language", filters.language));
	if (filters.finish) where.push(attribute("finish", filters.finish));
	if (filters.minCents !== null) where.push(sql`i.price_cents >= ${filters.minCents}`);
	if (filters.maxCents !== null) where.push(sql`i.price_cents <= ${filters.maxCents}`);
	return where;
}

const ITEM_ORDER: Record<ItemFilters["sort"], SQL> = {
	// Live sales first (soonest to close), then upcoming ones (soonest to open).
	ending: sql`ORDER BY s.status != 'live', COALESCE(s.closes_at, s.live_at) IS NULL, COALESCE(s.closes_at, s.live_at), i.sort_order, i.id`,
	starting: sql`ORDER BY s.status != 'scheduled', s.live_at IS NULL, s.live_at, i.sort_order, i.id`,
	price_asc: sql`ORDER BY i.price_cents, i.id`,
	price_desc: sql`ORDER BY i.price_cents DESC, i.id`,
	newest: sql`ORDER BY i.created_at DESC, i.id`,
};

/** A page of a game's discoverable items, filtered; `hasMore` when another page exists. */
export async function listGameItems(
	db: Db,
	gameId: string,
	filters: ItemFilters,
): Promise<{ items: ItemCard[]; hasMore: boolean }> {
	const where = [DISCOVERABLE, LISTED_ITEM, sql`i.game_id = ${gameId}`, ...filterClauses(filters)];
	const rows = await db.all<ItemRow>(
		sql`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM} WHERE ${sql.join(where, sql` AND `)}
			${ITEM_ORDER[filters.sort]} LIMIT ${ITEMS_PER_PAGE + 1} OFFSET ${(filters.page - 1) * ITEMS_PER_PAGE}`,
	);
	return { items: rows.slice(0, ITEMS_PER_PAGE).map(toItemCard), hasMore: rows.length > ITEMS_PER_PAGE };
}

export interface GameFacets {
	readonly sets: readonly string[];
	readonly rarities: readonly string[];
	readonly languages: readonly string[];
	readonly finishes: readonly string[];
}

/** The filter values a game's discoverable items actually have, most common first. */
export async function gameFacets(db: Db, gameId: string): Promise<GameFacets> {
	const rows = await db.all<{ key: string; value: string }>(
		sql`SELECT a.key, a.value_text AS value FROM item_attributes a
			JOIN items i ON i.id = a.item_id JOIN sales s ON s.id = i.sale_id JOIN users u ON u.id = s.seller_id
			WHERE ${DISCOVERABLE} AND ${LISTED_ITEM} AND i.game_id = ${gameId}
				AND a.key IN ('set_name', 'rarity', 'language', 'finish') AND a.value_text IS NOT NULL
			GROUP BY a.key, a.value_text ORDER BY count(*) DESC, a.value_text LIMIT 400`,
	);
	const of = (key: string) =>
		rows
			.filter((r) => r.key === key)
			.map((r) => r.value)
			.slice(0, 100);
	return { sets: of("set_name"), rarities: of("rarity"), languages: of("language"), finishes: of("finish") };
}

/** How many discoverable items each game has, for the browse page. */
export async function itemCountsByGame(db: Db): Promise<Map<string, number>> {
	const rows = await db.all<{ game_id: string; n: number }>(
		sql`SELECT i.game_id, count(*) AS n FROM ${ITEM_FROM} WHERE ${DISCOVERABLE} AND ${LISTED_ITEM} GROUP BY i.game_id`,
	);
	return new Map(rows.map((r) => [r.game_id, r.n]));
}

// ---------------------------------------------------------------------------
// Search and "who has this card?"

/** A catalog product with discoverable listings, for search results. */
export interface ProductMatch {
	readonly productId: number;
	readonly name: string;
	readonly setName: string;
	readonly number: string | null;
	readonly gameId: string;
	readonly listings: number;
	readonly fromCents: number;
}

export interface SearchResults {
	readonly terms: readonly string[];
	readonly products: readonly ProductMatch[];
	readonly items: readonly ItemCard[];
	readonly sales: readonly SaleCard[];
}

/** LIKE pattern for a word, with LIKE's wildcards escaped (`ESCAPE '\'`). */
const contains = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** FTS5 prefix query for the catalog, each word quoted so no FTS syntax is interpreted. */
const ftsQuery = (terms: readonly string[]) => terms.map((w) => `"${w.replaceAll('"', '""')}"*`).join(" ");

/**
 * Search over discoverable listings: catalog products that have listings (for "who has
 * this card?"), items whose title has every word, and sales whose title does.
 */
export async function search(db: Db, query: string, gameId: string | null = null): Promise<SearchResults> {
	const terms = searchTerms(query);
	if (terms.length === 0) return { terms, products: [], items: [], sales: [] };
	const game = gameId ? sql`i.game_id = ${gameId}` : sql`1 = 1`;
	const titleHas = (column: SQL) =>
		sql.join(
			terms.map((t) => sql`${column} LIKE ${contains(t)} ESCAPE '\\'`),
			sql` AND `,
		);
	const [products, items, sales] = await Promise.all([
		db.all<{
			product_id: number;
			name: string;
			set_name: string;
			number: string | null;
			game_id: string;
			listings: number;
			from_cents: number;
		}>(
			sql`SELECT p.id AS product_id, p.name, cs.name AS set_name, p.number, p.game_id,
					count(*) AS listings, min(i.price_cents) AS from_cents
				FROM ${ITEM_FROM}
				JOIN catalog_products p ON p.id = CAST(i.catalog_product_id AS INTEGER)
				JOIN catalog_sets cs ON cs.id = p.set_id
				WHERE ${DISCOVERABLE} AND ${LISTED_ITEM} AND ${game}
					AND p.id IN (SELECT rowid FROM catalog_search WHERE catalog_search MATCH ${ftsQuery(terms)})
				GROUP BY p.id ORDER BY listings DESC, p.name LIMIT 12`,
		),
		db.all<ItemRow>(
			sql`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
				WHERE ${DISCOVERABLE} AND ${LISTED_ITEM} AND ${game} AND ${titleHas(sql`i.title`)}
				${ITEM_ORDER.ending} LIMIT ${ITEMS_PER_PAGE}`,
		),
		db.all<SaleRow>(
			sql`SELECT ${SALE_COLUMNS} FROM sales s JOIN users u ON u.id = s.seller_id
				WHERE ${DISCOVERABLE} AND ${titleHas(sql`s.title`)}
					${gameId ? sql`AND EXISTS (SELECT 1 FROM items i WHERE i.sale_id = s.id AND ${game} AND ${LISTED_ITEM})` : sql``}
				ORDER BY s.status != 'live', s.live_at LIMIT 12`,
		),
	]);
	return {
		terms,
		products: products.map((p) => ({
			productId: p.product_id,
			name: p.name,
			setName: p.set_name,
			number: p.number,
			gameId: p.game_id,
			listings: p.listings,
			fromCents: p.from_cents,
		})),
		items: items.map(toItemCard),
		sales: sales.map(toSaleCard),
	};
}

export interface CatalogProductInfo {
	readonly productId: number;
	readonly name: string;
	readonly setName: string;
	readonly setCode: string | null;
	readonly number: string | null;
	readonly rarity: string | null;
	readonly productType: string | null;
	readonly gameId: string;
	readonly kind: "single" | "sealed";
}

/**
 * Every discoverable listing of one catalog product.
 *
 * @spec DISC-who-has — across public scheduled and live sales, available items first, then
 * cheapest first; null when the catalog has no such product.
 */
export async function whoHas(
	db: Db,
	productId: number,
): Promise<{ product: CatalogProductInfo; listings: ItemCard[] } | null> {
	const product = await db.get<
		| {
				id: number;
				name: string;
				set_name: string;
				set_code: string | null;
				number: string | null;
				rarity: string | null;
				product_type: string | null;
				game_id: string;
				kind: "single" | "sealed";
		  }
		| undefined
	>(
		sql`SELECT p.id, p.name, cs.name AS set_name, cs.code AS set_code, p.number, p.rarity, p.product_type,
				p.game_id, p.kind
			FROM catalog_products p JOIN catalog_sets cs ON cs.id = p.set_id WHERE p.id = ${productId}`,
	);
	if (!product) return null;
	const rows = await db.all<ItemRow>(
		sql`SELECT ${ITEM_COLUMNS} FROM ${ITEM_FROM}
			WHERE ${DISCOVERABLE} AND ${LISTED_ITEM} AND i.catalog_product_id = ${String(productId)}
			ORDER BY i.state NOT IN ('available', 'deciding'), i.price_cents, i.id LIMIT 200`,
	);
	return {
		product: {
			productId: product.id,
			name: product.name,
			setName: product.set_name,
			setCode: product.set_code,
			number: product.number,
			rarity: product.rarity,
			productType: product.product_type,
			gameId: product.game_id,
			kind: product.kind,
		},
		listings: rows.map(toItemCard),
	};
}

/** Public, scheduled or live sales for the sitemap, newest first. */
export async function sitemapSales(
	db: Db,
	limit = 5000,
): Promise<Array<{ slug: string; updatedAt: Millis }>> {
	const rows = await db.all<{ slug: string; updated_at: number }>(
		sql`SELECT s.slug, s.updated_at FROM sales s JOIN users u ON u.id = s.seller_id
			WHERE ${DISCOVERABLE} ORDER BY s.updated_at DESC LIMIT ${limit}`,
	);
	return rows.map((r) => ({ slug: r.slug, updatedAt: r.updated_at }));
}
