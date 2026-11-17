import {
	MARKET_PERCENT_PRESETS,
	matchCatalog,
	type Attributes,
	type CatalogLookup,
	type CatalogMatch,
	type CatalogProduct,
	type ItemKind,
	type Millis,
} from "@claimsale/core";
import { sql, type Db } from "@claimsale/db";
import { sellerProfiles } from "@claimsale/db/schema";
import type { CatalogHit, MarketPrice } from "#lib/market.ts";

/**
 * The web Worker's reads of the TCGCSV catalog (WS-C's tables, the same D1 database).
 * The type-ahead itself goes through the engine's `searchCatalog` RPC (FTS ranking
 * lives there); imports need lookups by ID and by set + number, and prices for many
 * products at once, so they read D1 here.
 */

interface ProductRow {
	readonly id: number;
	readonly tcgplayer_product_id: number;
	readonly game_id: string;
	readonly kind: "single" | "sealed";
	readonly name: string;
	readonly set_name: string;
	readonly set_code: string | null;
	readonly number: string | null;
	readonly rarity: string | null;
	readonly product_type: string | null;
}

const PRODUCT_COLUMNS = sql.raw(`p.id, p.tcgplayer_product_id, p.game_id, p.kind, p.name, s.name AS set_name,
	s.code AS set_code, p.number, p.rarity, p.product_type`);
const PRODUCT_FROM = sql.raw(
	"catalog_products p JOIN catalog_sets s ON s.id = p.set_id JOIN games g ON g.id = p.game_id",
);

/** A catalog row as an autofill suggestion: the autofill fields and IDs, never a price. */
export function toHit(row: ProductRow): CatalogHit {
	return {
		productId: row.id,
		tcgplayerProductId: row.tcgplayer_product_id,
		game: row.game_id,
		kind: row.kind,
		name: row.name,
		setName: row.set_name,
		setCode: row.set_code,
		number: row.number,
		rarity: row.rarity,
		productType: row.product_type,
	};
}

/** Core's catalog product shape, keeping our row ID alongside it. */
const toProduct = (hit: CatalogHit): CatalogProduct & { readonly productId: number } => ({
	productId: hit.productId,
	tcgplayerProductId: hit.tcgplayerProductId,
	game: hit.game,
	kind: hit.kind,
	name: hit.name,
	setCode: hit.setCode,
	setName: hit.setName,
	number: hit.number,
	rarity: hit.rarity,
	productType: hit.productType,
});

/** FTS5 prefix terms for a name, each quoted so no FTS syntax is interpreted. */
function ftsQuery(text: string): string | null {
	const words = text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 0)
		.slice(0, 8);
	return words.length === 0 ? null : words.map((w) => `"${w.replaceAll('"', '""')}"*`).join(" ");
}

/**
 * Core's injected catalog lookup (TCG-catalog-match) over D1. Only enabled games are
 * searched. Product IDs can be prefetched in one query with {@link prefetch}.
 */
export function catalogLookup(db: Db): CatalogLookup & {
	prefetch(tcgplayerProductIds: readonly number[]): Promise<void>;
} {
	const byTcgplayerId = new Map<number, CatalogHit | null>();
	const select = async (where: ReturnType<typeof sql>, limit = 50) =>
		(
			await db.all<ProductRow>(
				sql`SELECT ${PRODUCT_COLUMNS} FROM ${PRODUCT_FROM} WHERE g.enabled = 1 AND ${where} LIMIT ${limit}`,
			)
		).map(toHit);
	return {
		async prefetch(ids) {
			const wanted = [...new Set(ids)].filter((id) => !byTcgplayerId.has(id));
			if (wanted.length === 0) return;
			const hits = await select(
				sql`p.tcgplayer_product_id IN (SELECT value FROM json_each(${JSON.stringify(wanted)}))`,
				wanted.length,
			);
			for (const id of wanted) byTcgplayerId.set(id, null);
			for (const hit of hits) byTcgplayerId.set(hit.tcgplayerProductId, hit);
		},
		async byProductId(id) {
			if (!byTcgplayerId.has(id)) await this.prefetch([id]);
			const hit = byTcgplayerId.get(id);
			return hit ? toProduct(hit) : null;
		},
		async bySetAndNumber(game, setCode, number) {
			const hits = await select(
				sql`p.game_id = ${game} AND lower(s.code) = lower(${setCode})
					AND (p.number = ${number} OR p.number LIKE ${`${number}/%`})`,
			);
			return hits.map(toProduct);
		},
		async byName(game, name, setCode) {
			const match = ftsQuery(name);
			if (match === null) return [];
			const hits = await select(
				sql`p.game_id = ${game} AND p.id IN (SELECT rowid FROM catalog_search WHERE catalog_search MATCH ${match})
					AND (${setCode} IS NULL OR lower(s.code) = lower(${setCode}))`,
				25,
			);
			return hits.map(toProduct);
		},
	};
}

export interface RowMatchInput {
	readonly row: number;
	readonly game: string | null;
	readonly kind: ItemKind;
	readonly attributes: Attributes;
}

export type RowMatch =
	| { readonly row: number; readonly status: "matched"; readonly product: CatalogHit }
	| { readonly row: number; readonly status: "ambiguous"; readonly candidates: readonly CatalogHit[] }
	| { readonly row: number; readonly status: "unmatched" };

const productHit = (product: CatalogProduct): CatalogHit => {
	const productId: unknown = Reflect.get(product, "productId");
	return {
		productId: typeof productId === "number" ? productId : 0,
		tcgplayerProductId: product.tcgplayerProductId,
		game: product.game,
		kind: product.kind,
		name: product.name,
		setName: product.setName ?? "",
		setCode: product.setCode,
		number: product.number,
		rarity: product.rarity,
		productType: product.productType,
	};
};

const fromMatch = (row: number, match: CatalogMatch): RowMatch =>
	match.status === "matched"
		? { row, status: "matched", product: productHit(match.product) }
		: match.status === "ambiguous"
			? { row, status: "ambiguous", candidates: match.candidates.map(productHit) }
			: { row, status: "unmatched" };

/**
 * Matches import rows to the catalog, in core's order (TCG-catalog-match): product IDs
 * are prefetched in one query, then each remaining row tries set + number and name.
 */
export async function matchRows(db: Db, rows: readonly RowMatchInput[]): Promise<RowMatch[]> {
	const lookup = catalogLookup(db);
	await lookup.prefetch(
		rows
			.map((r) => r.attributes["tcgplayer_product_id"])
			.filter((id): id is number => typeof id === "number"),
	);
	const out: RowMatch[] = [];
	for (const row of rows) {
		// Sequential: each row is at most a couple of small indexed queries.
		// oxlint-disable-next-line no-await-in-loop
		out.push(fromMatch(row.row, await matchCatalog(row, lookup)));
	}
	return out;
}

/** The `catalog_products.id` for a TCGplayer product ID in the attributes, as items store it. */
export async function catalogProductIdFor(db: Db, attributes: Attributes): Promise<string | null> {
	const id = attributes["tcgplayer_product_id"];
	if (typeof id !== "number") return null;
	const row = await db.get<{ id: number } | undefined>(
		sql`SELECT id FROM catalog_products WHERE tcgplayer_product_id = ${id}`,
	);
	return row ? String(row.id) : null;
}

/**
 * The latest TCGplayer market prices of many catalog products, per subtype.
 *
 * @spec TCG-market-placeholder — a seller's listing aid. Only the /sell pages and
 * endpoints call this, after `requireSeller` and an own-sale check; nothing a buyer
 * can load reads `market_prices` (WS-C's engine RPC applies the same rule).
 */
export async function marketPricesFor(
	db: Db,
	productIds: readonly number[],
): Promise<Map<number, MarketPrice[]>> {
	const out = new Map<number, MarketPrice[]>();
	const ids = [...new Set(productIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
	if (ids.length === 0) return out;
	const rows = await db.all<{
		product_id: number;
		subtype: string;
		market_cents: number | null;
		as_of: number;
	}>(
		sql`SELECT product_id, subtype, market_cents, as_of FROM market_prices
			WHERE product_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
			ORDER BY product_id, subtype`,
	);
	for (const row of rows) {
		const list = out.get(row.product_id) ?? [];
		list.push({ subtype: row.subtype, marketCents: row.market_cents, asOf: row.as_of });
		out.set(row.product_id, list);
	}
	return out;
}

// ---------------------------------------------------------------------------
// The seller's default "% of market" (D64, `seller_profiles.default_market_pct`)

export const isMarketPercent = (value: number): boolean =>
	(MARKET_PERCENT_PRESETS as readonly number[]).includes(value);

export async function defaultMarketPercent(db: Db, sellerId: string): Promise<number | null> {
	const row = await db.get<{ pct: number | null } | undefined>(
		sql`SELECT default_market_pct AS pct FROM seller_profiles WHERE user_id = ${sellerId}`,
	);
	const pct = row?.pct ?? null;
	return pct !== null && isMarketPercent(pct) ? pct : null;
}

/** Saves (or clears, with null) the highlighted % button. Only the preset values are accepted. */
export async function setDefaultMarketPercent(
	db: Db,
	sellerId: string,
	percent: number | null,
	now: Millis,
): Promise<boolean> {
	if (percent !== null && !isMarketPercent(percent)) return false;
	await db
		.insert(sellerProfiles)
		.values({ userId: sellerId, defaultMarketPct: percent, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: sellerProfiles.userId,
			set: { defaultMarketPct: percent, updatedAt: now },
		});
	return true;
}
