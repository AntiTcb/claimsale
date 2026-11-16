import { Data, Effect, Schema } from "effect";
import { CatalogDbError, query } from "./store.ts";

/**
 * The seller's catalog type-ahead (PLAN 3 "Autofill UX", D60) over the FTS5 index,
 * and the seller-only market price lookup (D64).
 */

export const CatalogSearchInput = Schema.Struct({
	query: Schema.String.check(Schema.isMaxLength(100)),
	/** Restrict to one game (id / slug). */
	game: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
});
export type CatalogSearchInput = typeof CatalogSearchInput.Type;

/**
 * One autofill suggestion: exactly the fields autofill may set (`TCG-autofill-only`)
 * plus IDs. It carries no market price, so it is safe in any response.
 */
export interface CatalogSearchHit {
	readonly productId: number;
	readonly tcgplayerProductId: number;
	readonly game: string;
	readonly kind: "single" | "sealed";
	readonly name: string;
	readonly setName: string;
	readonly setCode: string | null;
	readonly number: string | null;
	readonly rarity: string | null;
	readonly productType: string | null;
}

const MAX_TOKENS = 8;

/**
 * Letters and digits without diacritics, split the way the FTS5 `unicode61`
 * tokenizer (`remove_diacritics 2`) splits them: "Pokémon" → "Pokemon".
 */
export function searchWords(text: string): string[] {
	return text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);
}

/**
 * Turns what a seller typed into an FTS5 query: every word becomes a quoted prefix
 * term, so FTS syntax in the input is never interpreted. Null when nothing is left.
 */
export function toFtsQuery(input: string): string | null {
	const tokens = searchWords(input).slice(0, MAX_TOKENS);
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" ");
}

interface HitRow {
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

/** How well a product name matches the typed words: 0 exact, 1 prefix, 2 every word, 3 other. */
export function nameTier(name: string, typed: ReadonlyArray<string>): number {
	const words = searchWords(name).map((w) => w.toLowerCase());
	const wanted = typed.map((w) => w.toLowerCase());
	if (words.join(" ") === wanted.join(" ")) return 0;
	const prefix = wanted.every((q, i) => (i === wanted.length - 1 ? words[i]?.startsWith(q) : words[i] === q));
	if (prefix) return 1;
	return wanted.every((q) => words.some((w) => w.startsWith(q))) ? 2 : 3;
}

/** FTS candidates read before re-ranking. */
const CANDIDATES = 100;

/**
 * Ranking: names equal to what was typed first, then names starting with it, then
 * names containing every word (so a match on the set name or number ranks below a
 * match on the name); within a tier, FTS5's bm25 with the name weighted highest
 * (name 10, number 5, set code 3, set name 2), then newer sets.
 */
export const searchCatalog = (db: D1Database, input: CatalogSearchInput) =>
	Effect.gen(function* () {
		const match = toFtsQuery(input.query);
		if (match === null) return [] as CatalogSearchHit[];
		const typed = searchWords(input.query).slice(0, MAX_TOKENS);
		const rows = yield* query<HitRow>(
			"search catalog",
			db
				.prepare(
					`SELECT p.id, p.tcgplayer_product_id, p.game_id, p.kind, p.name, s.name AS set_name,
						s.code AS set_code, p.number, p.rarity, p.product_type
					FROM catalog_search
					JOIN catalog_products p ON p.id = catalog_search.rowid
					JOIN catalog_sets s ON s.id = p.set_id
					JOIN games g ON g.id = p.game_id
					WHERE catalog_search MATCH ?1 AND g.enabled = 1 AND (?2 IS NULL OR p.game_id = ?2)
					ORDER BY bm25(catalog_search, 10.0, 2.0, 3.0, 5.0), s.release_date DESC NULLS LAST, p.id
					LIMIT ${CANDIDATES}`,
				)
				.bind(match, input.game ?? null),
		);
		// Sorting is stable, so bm25 order is kept within a tier.
		const ranked = rows
			.map((row) => ({ row, tier: nameTier(row.name, typed) }))
			.toSorted((a, b) => a.tier - b.tier)
			.slice(0, input.limit ?? 10);
		return ranked.map(({ row: r }): CatalogSearchHit => ({
			productId: r.id,
			tcgplayerProductId: r.tcgplayer_product_id,
			game: r.game_id,
			kind: r.kind,
			name: r.name,
			setName: r.set_name,
			setCode: r.set_code,
			number: r.number,
			rarity: r.rarity,
			productType: r.product_type,
		}));
	}).pipe(Effect.withSpan("catalog.search"));

export const MarketPriceInput = Schema.Struct({
	/**
	 * Who is asking, as the web Worker authenticated them. `canSell` is true only for a
	 * signed-in user editing their own listing (seller requirements, D55).
	 */
	viewer: Schema.Struct({ userId: Schema.String, canSell: Schema.Boolean }),
	productId: Schema.Int,
});
export type MarketPriceInput = typeof MarketPriceInput.Type;

export interface MarketPriceView {
	readonly productId: number;
	readonly tcgplayerProductId: number;
	readonly prices: ReadonlyArray<{
		readonly subtype: string;
		readonly marketCents: number | null;
		/** When this value last changed (ms). */
		readonly asOf: number;
	}>;
	/** When the prices were last confirmed against TCGCSV (ms); null if never. */
	readonly checkedAt: number | null;
}

export class MarketPriceForbidden extends Data.TaggedError("MarketPriceForbidden")<{}> {
	override get message() {
		return "Market prices are only shown to sellers";
	}
}

export class CatalogProductNotFound extends Data.TaggedError("CatalogProductNotFound")<{
	readonly productId: number;
}> {
	override get message() {
		return `No catalog product ${this.productId}`;
	}
}

/**
 * The TCGplayer market price for a product, per subtype, as a seller's listing aid.
 *
 * @spec TCG-market-placeholder — the only read of `market_prices`, and it refuses
 * anyone who isn't acting as a seller. Buyer-facing responses never call it, and
 * search hits carry no prices.
 */
export const sellerMarketPrices = (
	db: D1Database,
	input: MarketPriceInput,
): Effect.Effect<MarketPriceView, MarketPriceForbidden | CatalogProductNotFound | CatalogDbError> =>
	Effect.gen(function* () {
		if (!input.viewer.canSell) return yield* new MarketPriceForbidden();
		const [product] = yield* query<{ id: number; tcgplayer_product_id: number; synced_at: number | null }>(
			"read product",
			db
				.prepare(
					`SELECT p.id, p.tcgplayer_product_id, s.synced_at FROM catalog_products p
					JOIN catalog_sets s ON s.id = p.set_id WHERE p.id = ?`,
				)
				.bind(input.productId),
		);
		if (product === undefined) return yield* new CatalogProductNotFound({ productId: input.productId });
		const prices = yield* query<{ subtype: string; market_cents: number | null; as_of: number }>(
			"read market prices",
			db
				.prepare(
					"SELECT subtype, market_cents, as_of FROM market_prices WHERE product_id = ? ORDER BY subtype",
				)
				.bind(product.id),
		);
		return {
			productId: product.id,
			tcgplayerProductId: product.tcgplayer_product_id,
			prices: prices.map((p) => ({ subtype: p.subtype, marketCents: p.market_cents, asOf: p.as_of })),
			checkedAt: product.synced_at,
		};
	}).pipe(Effect.withSpan("catalog.market_prices"));
