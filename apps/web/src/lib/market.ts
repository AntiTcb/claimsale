import { marketHint, type Attributes, type MarketHint, type MarketQuote } from "@claimsale/core";

/**
 * The market price aid (D64) on the client: which TCGCSV price fits an item, and the
 * hint the price field shows. Only the item's seller ever receives prices; the
 * /sell endpoints check that before sending any (TCG-market-placeholder).
 */

/** An autofill suggestion: the catalog fields autofill may set, and IDs. No price. */
export interface CatalogHit {
	/** `catalog_products.id`. */
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

/** One TCGCSV price for a product, per subtype ("Normal", "Foil", "Reverse Holofoil"…). */
export interface MarketPrice {
	readonly subtype: string;
	readonly marketCents: number | null;
	readonly asOf: number;
}

const FINISH_SUBTYPE: Readonly<Record<string, string>> = {
	normal: "Normal",
	"non-foil": "Normal",
	"non-holo": "Normal",
	foil: "Foil",
	etched: "Foil",
	holo: "Holofoil",
	"reverse-holo": "Reverse Holofoil",
};

const EDITION_SUBTYPE: Readonly<Record<string, string>> = {
	"1st": "1st Edition",
	"1st-edition": "1st Edition",
	unlimited: "Unlimited",
	limited: "Limited",
};

const text = (attributes: Attributes, key: string) => {
	const value = attributes[key];
	return typeof value === "string" ? value : null;
};

/**
 * TCGCSV subtype names for an item's finish and edition, best match first: Pokémon
 * prices "1st Edition Holofoil", Yu-Gi-Oh! "1st Edition", most games "Normal" / "Foil".
 */
export function marketSubtypes(attributes: Attributes): string[] {
	const finish = text(attributes, "finish");
	const base = finish === null ? null : (FINISH_SUBTYPE[finish] ?? null);
	const editionKey = text(attributes, "edition");
	const edition = editionKey === null ? null : (EDITION_SUBTYPE[editionKey] ?? null);
	const out: string[] = [];
	if (edition !== null) {
		if (base !== null) out.push(`${edition} ${base}`);
		out.push(edition);
	}
	if (base !== null) out.push(base);
	return out;
}

/**
 * The market price that fits the item, or null. Without a finish only a product with
 * a single priced subtype qualifies; the seller picks the finish otherwise.
 */
export function pickMarketQuote(prices: readonly MarketPrice[], attributes: Attributes): MarketQuote | null {
	const priced = prices.filter(
		(p): p is MarketPrice & { marketCents: number } => p.marketCents !== null && p.marketCents > 0,
	);
	for (const subtype of marketSubtypes(attributes)) {
		const hit = priced.find((p) => p.subtype.toLowerCase() === subtype.toLowerCase());
		if (hit) return { marketCents: hit.marketCents, asOf: hit.asOf };
	}
	const only = priced.length === 1 ? priced[0] : undefined;
	return only && text(attributes, "finish") === null
		? { marketCents: only.marketCents, asOf: only.asOf }
		: null;
}

/**
 * The price field's hint for one of the seller's own items.
 *
 * @spec TCG-market-placeholder — the page only ever has prices for its own seller, so
 * the viewer is the seller here; core still drops graded, accessory, lot and
 * uncatalogued items.
 */
export function sellerMarketHint(input: {
	readonly kind: string;
	readonly attributes: Attributes;
	readonly prices: readonly MarketPrice[] | null;
	readonly defaultPercent: number | null;
}): MarketHint | null {
	const kind = input.kind;
	if (kind !== "single" && kind !== "sealed") return null;
	const id = input.attributes["tcgplayer_product_id"];
	return marketHint({
		viewerId: "seller",
		sellerId: "seller",
		kind,
		tcgplayerProductId: typeof id === "number" ? id : null,
		quote: input.prices ? pickMarketQuote(input.prices, input.attributes) : null,
		defaultPercent: input.defaultPercent,
	});
}

/** Reads an item's attributes JSON text (the table editor's field) leniently: {} when unreadable. */
export function readAttributes(json: string): Record<string, string | number | boolean> {
	try {
		const parsed: unknown = JSON.parse(json || "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const out: Record<string, string | number | boolean> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
				out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}
