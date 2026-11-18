import type { AttributeValue, Attributes, ItemKind } from "./attributes.ts";
import { err, ok, type Millis, type Rejection, type Result } from "./common.ts";
import { MARKET_PERCENT_PRESETS, priceFromMarketPercent, type Cents } from "./money.ts";

/**
 * TCG listing rules (PLAN §3 "TCG catalog and item model", D60, D62, D64): what can
 * be listed, which items need tracked shipping, catalog autofill, and the market
 * price aid that only the seller ever sees.
 */

// ---------------------------------------------------------------------------
// Listing policy (D62)

/** Shown on every repack listing (D62). */
export const REPACK_LABEL = "Repack, not factory sealed";

export interface ListingText {
	readonly kind: ItemKind;
	readonly title: string;
	readonly description: string;
	readonly attributes: Attributes;
}

export type PolicyViolation = Rejection<"code_card" | "altered_unflagged" | "repack_unflagged"> & {
	readonly field: string;
};

const CODE_CARD = [
	/\bcode\s*cards?\b/i,
	/\b(?:ptcgl|ptcgo|tcg\s*live|tcgo|mtga|mtg\s*arena|arena|online|digital|redeemable|redemption)\s+codes?\b/i,
	/\bcodes?\s+(?:for|to)\s+(?:ptcgl|ptcgo|tcg\s*live|mtg\s*arena|arena)\b/i,
];
const ALTERED = /\baltered\b/i;
const REPACK = /\b(?:repack(?:ed|s)?|not\s+factory\s+sealed)\b/i;

function textOf(listing: ListingText, keys: readonly string[]): string {
	const parts = [listing.title, listing.description];
	for (const key of keys) {
		const value = listing.attributes[key];
		if (typeof value === "string") parts.push(value);
	}
	return parts.join("\n");
}

/**
 * Policy problems with a listing; an empty list means it can be listed.
 *
 * @spec TCG-no-code-cards
 *
 * Digital code cards (PTCGL, Arena or any other redeemable code) are never allowed.
 * A single whose text says "altered" must carry the altered flag, and sealed product
 * described as a repack must carry the repack flag (which shows {@link REPACK_LABEL}).
 */
export function listingPolicyViolations(listing: ListingText): PolicyViolation[] {
	const violations: PolicyViolation[] = [];
	const all = textOf(listing, ["name", "product_type", "set_name", "rarity"]);
	// Sealed product often *contains* a code card ("ETB, code card included"), which is
	// fine; it's only a code card listing when the product itself is one.
	const codeText =
		listing.kind === "sealed"
			? [listing.attributes["name"], listing.attributes["product_type"]]
					.filter((v) => typeof v === "string")
					.join("\n")
			: all;
	if (CODE_CARD.some((pattern) => pattern.test(codeText))) {
		violations.push({
			code: "code_card",
			field: "title",
			message: "Digital code cards can't be listed on ClaimSale",
		});
	}
	if (listing.kind === "single" && listing.attributes["altered"] !== true && ALTERED.test(all)) {
		violations.push({
			code: "altered_unflagged",
			field: "altered",
			message: 'Altered cards need the "altered" flag',
		});
	}
	if (listing.kind === "sealed" && listing.attributes["repack"] !== true && REPACK.test(all)) {
		violations.push({
			code: "repack_unflagged",
			field: "repack",
			message: `Repacks need the repack flag, which labels them "${REPACK_LABEL}"`,
		});
	}
	return violations;
}

/** Labels a listing must show (D62). */
export function listingLabels(kind: ItemKind, attributes: Attributes): string[] {
	const labels: string[] = [];
	if (kind === "single" && attributes["altered"] === true) labels.push("Altered");
	if (kind === "sealed" && attributes["repack"] === true) labels.push(REPACK_LABEL);
	return labels;
}

// Tracked shipping for graded and sealed items (TCG-tracked-graded-sealed) lives in
// invoice.ts with the rest of the shipping rules: `requiresTrackedShipping`,
// `shippingOptionsFor`, `trackingRequiredFor`.

// ---------------------------------------------------------------------------
// Catalog autofill (D60)

/** A TCGCSV catalog product, as the catalog search returns it. */
export interface CatalogProduct {
	readonly tcgplayerProductId: number;
	readonly game: string;
	readonly kind: "single" | "sealed";
	readonly name: string;
	readonly setCode: string | null;
	readonly setName: string | null;
	readonly number: string | null;
	readonly rarity: string | null;
	readonly productType: string | null;
}

/** The only attributes autofill may write; everything else belongs to the seller. */
export const AUTOFILL_KEYS = [
	"name",
	"set_code",
	"set_name",
	"number",
	"rarity",
	"product_type",
	"tcgplayer_product_id",
] as const;

export interface AutofillTarget {
	readonly game: string | null;
	readonly kind: ItemKind;
	readonly attributes: Attributes;
}

/**
 * - `replace`: the seller picked a product in the type-ahead; its catalog fields
 *   replace the old ones (so picking a different card doesn't leave a stale number).
 * - `fill-blanks`: an import row matched the catalog; only empty catalog fields are
 *   filled, so what the seller's file says wins.
 */
export type AutofillMode = "replace" | "fill-blanks";

function catalogValues(product: CatalogProduct, kind: ItemKind): Record<string, AttributeValue | null> {
	return {
		name: product.name,
		set_code: product.setCode,
		set_name: product.setName,
		number: kind === "sealed" ? null : product.number,
		rarity: kind === "sealed" ? null : product.rarity,
		product_type: kind === "sealed" ? product.productType : null,
		tcgplayer_product_id: product.tcgplayerProductId,
	};
}

/**
 * Merges a catalog product into an item.
 *
 * @spec TCG-autofill-only
 *
 * Only the game and the {@link AUTOFILL_KEYS} attributes can change. Price, condition,
 * finish, language, quantity, description, photos and every other field are returned
 * exactly as they were (the generic `T` carries them through untouched).
 */
export function applyCatalogAutofill<T extends AutofillTarget>(
	item: T,
	product: CatalogProduct,
	mode: AutofillMode,
): Result<T, Rejection<"not_catalogued" | "kind_mismatch" | "game_mismatch">> {
	if (item.kind === "accessory" || item.kind === "lot") {
		return err({ code: "not_catalogued", message: "Accessories and lots aren't in the catalog" });
	}
	const productKind = item.kind === "sealed" ? "sealed" : "single";
	if (product.kind !== productKind) {
		return err({ code: "kind_mismatch", message: `That catalog entry isn't a ${productKind} product` });
	}
	if (mode === "fill-blanks" && item.game !== null && item.game !== product.game) {
		return err({ code: "game_mismatch", message: "That catalog entry is from another game" });
	}
	const attributes: Record<string, AttributeValue> = { ...item.attributes };
	for (const [key, value] of Object.entries(catalogValues(product, item.kind))) {
		if (mode === "fill-blanks") {
			if (attributes[key] === undefined && value !== null) attributes[key] = value;
		} else if (value === null) {
			delete attributes[key];
		} else {
			attributes[key] = value;
		}
	}
	const game = mode === "replace" ? product.game : (item.game ?? product.game);
	return ok({ ...item, game, attributes });
}

// ---------------------------------------------------------------------------
// Market price aid (D64): seller-only

/** The latest TCGplayer market price for a product + finish (TCGCSV subtype). */
export interface MarketQuote {
	readonly marketCents: Cents;
	readonly asOf: Millis;
}

export interface MarketHint {
	/** e.g. "Market $12.40 · updated Oct 8" */
	readonly placeholder: string;
	readonly marketCents: Cents;
	/** The quick buttons; nothing is filled in until the seller clicks one. */
	readonly presets: readonly { readonly percent: number; readonly priceCents: Cents }[];
	readonly highlightedPercent: number | null;
}

const marketDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dollars = (cents: Cents) => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/**
 * The price field's market hint, for the item's seller only.
 *
 * @spec TCG-market-placeholder
 *
 * Returns null for anyone who isn't the item's seller, and for graded, accessory,
 * lot and uncatalogued items (TCGCSV has no price for them). The hint is only a
 * placeholder and button values: it never sets the price itself.
 */
export function marketHint(input: {
	readonly viewerId: string | null;
	readonly sellerId: string;
	readonly kind: ItemKind;
	readonly tcgplayerProductId: number | null;
	readonly quote: MarketQuote | null;
	readonly defaultPercent?: number | null;
}): MarketHint | null {
	const { viewerId, sellerId, kind, tcgplayerProductId, quote } = input;
	if (viewerId === null || viewerId !== sellerId) return null;
	if (kind !== "single" && kind !== "sealed") return null;
	if (tcgplayerProductId === null || quote === null || quote.marketCents <= 0) return null;
	const defaultPercent = input.defaultPercent ?? null;
	return {
		placeholder: `Market ${dollars(quote.marketCents)} · updated ${marketDate.format(quote.asOf)}`,
		marketCents: quote.marketCents,
		presets: MARKET_PERCENT_PRESETS.map((percent) => ({
			percent,
			priceCents: priceFromMarketPercent(quote.marketCents, percent),
		})),
		highlightedPercent:
			defaultPercent !== null && (MARKET_PERCENT_PRESETS as readonly number[]).includes(defaultPercent)
				? defaultPercent
				: null,
	};
}

/** Keys that hold market data anywhere in a response. */
const MARKET_KEY = /market/i;

type StripMarket<T> = T extends readonly (infer U)[]
	? StripMarket<U>[]
	: T extends object
		? {
				[
					K in keyof T as K extends string ? (Lowercase<K> extends `${string}market${string}` ? never : K) : K
				]: StripMarket<T[K]>;
			}
		: T;

/**
 * The buyer-facing projection of anything item-shaped.
 *
 * @spec TCG-market-placeholder
 *
 * Removes every key that mentions "market", at any depth, so no buyer response,
 * export or page can carry a market price, however the item type grows.
 */
export function buyerFacing<T>(value: T): StripMarket<T> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stripMarket removes exactly the keys StripMarket drops
	return stripMarket(value) as StripMarket<T>;
}

function stripMarket(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripMarket);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		if (!MARKET_KEY.test(key)) out[key] = stripMarket(inner);
	}
	return out;
}

export interface BulkPriceCandidate {
	readonly itemId: string;
	readonly priceCents: Cents | null;
	readonly selected: boolean;
	/** The market price for the item's product + finish; null when there's no hint. */
	readonly marketCents: Cents | null;
}

export interface BulkPricePreview {
	readonly percent: number;
	readonly changes: readonly {
		readonly itemId: string;
		readonly fromCents: Cents | null;
		readonly toCents: Cents;
	}[];
	readonly skipped: readonly { readonly itemId: string; readonly reason: "no_market" | "unchanged" }[];
}

/**
 * "Set all selected / blank prices to N% of market", as a preview.
 *
 * @spec TCG-market-pct
 *
 * Nothing changes until the seller confirms; {@link applyBulkPricePreview} applies
 * exactly the previewed changes.
 */
export function previewBulkMarketPrice(
	items: readonly BulkPriceCandidate[],
	percent: number,
	scope: "selected" | "blank",
): BulkPricePreview {
	const changes: { itemId: string; fromCents: Cents | null; toCents: Cents }[] = [];
	const skipped: { itemId: string; reason: "no_market" | "unchanged" }[] = [];
	for (const item of items) {
		const inScope = scope === "selected" ? item.selected : item.priceCents === null;
		if (!inScope) continue;
		if (item.marketCents === null || item.marketCents <= 0) {
			skipped.push({ itemId: item.itemId, reason: "no_market" });
			continue;
		}
		const toCents = priceFromMarketPercent(item.marketCents, percent);
		if (toCents === item.priceCents) skipped.push({ itemId: item.itemId, reason: "unchanged" });
		else changes.push({ itemId: item.itemId, fromCents: item.priceCents, toCents });
	}
	return { percent, changes, skipped };
}

/** Applies a confirmed preview: the new price per item ID. */
export function applyBulkPricePreview(preview: BulkPricePreview): ReadonlyMap<string, Cents> {
	return new Map(preview.changes.map((change) => [change.itemId, change.toCents]));
}
