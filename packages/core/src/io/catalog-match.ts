import type { Attributes, ItemKind } from "../attributes.ts";
import type { CatalogProduct } from "../tcg.ts";

/**
 * Matching imported rows to the TCGCSV catalog (PLAN §3c.1). The lookups are
 * injected, so this stays pure: the server passes D1 queries, tests pass arrays, and
 * a batch importer can prefetch candidates and pass an in-memory lookup.
 */

type Awaitable<T> = T | Promise<T>;

export interface CatalogLookup {
	byProductId(tcgplayerProductId: number): Awaitable<CatalogProduct | null>;
	/** Products in a set with this collector number (several printings can share one). */
	bySetAndNumber(game: string, setCode: string, number: string): Awaitable<readonly CatalogProduct[]>;
	/** Fuzzy name search (FTS5), narrowed to a set when one is given. */
	byName(game: string, name: string, setCode: string | null): Awaitable<readonly CatalogProduct[]>;
}

export type MatchStep = "product_id" | "set_number" | "name_set";

export type CatalogMatch =
	| { readonly status: "matched"; readonly product: CatalogProduct; readonly by: MatchStep }
	| { readonly status: "ambiguous"; readonly candidates: readonly CatalogProduct[]; readonly by: MatchStep }
	| { readonly status: "unmatched" };

/** At most this many candidates are offered for the seller to choose from. */
export const MAX_CANDIDATES = 10;
/** Fuzzy candidates below this name similarity aren't offered. */
export const MIN_SIMILARITY = 0.5;

const normalize = (value: string) =>
	value
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

function bigrams(value: string): Map<string, number> {
	const grams = new Map<string, number>();
	const text = normalize(value).replaceAll(" ", "");
	for (let i = 0; i < text.length - 1; i++) {
		const gram = text.slice(i, i + 2);
		grams.set(gram, (grams.get(gram) ?? 0) + 1);
	}
	return grams;
}

/** Sørensen–Dice similarity of two names over character bigrams, in 0..1. */
export function nameSimilarity(a: string, b: string): number {
	const x = bigrams(a);
	const y = bigrams(b);
	let total = 0;
	let shared = 0;
	for (const count of x.values()) total += count;
	for (const [gram, count] of y) {
		total += count;
		shared += Math.min(count, x.get(gram) ?? 0);
	}
	if (total === 0) return normalize(a) === normalize(b) ? 1 : 0;
	return (2 * shared) / total;
}

const text = (attributes: Attributes, key: string) => {
	const value = attributes[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const sameSet = (product: CatalogProduct, setCode: string | null) =>
	setCode === null || product.setCode?.toLowerCase() === setCode.toLowerCase();

/**
 * Finds the catalog product for an imported row.
 *
 * @spec TCG-catalog-match
 *
 * Order: the TCGplayer product ID, then set + collector number (singles), then a fuzzy
 * name + set search. One exact hit is a match; several plausible hits are ambiguous
 * and the seller chooses; nothing plausible leaves the row uncatalogued. The catalog
 * only autofills (TCG-autofill-only), so an unmatched row still imports.
 */
export async function matchCatalog(
	row: { readonly game: string | null; readonly kind: ItemKind; readonly attributes: Attributes },
	lookup: CatalogLookup,
): Promise<CatalogMatch> {
	if (row.kind === "accessory" || row.kind === "lot" || row.game === null) return { status: "unmatched" };
	const game = row.game;
	const productKind = row.kind === "sealed" ? "sealed" : "single";
	const fits = (product: CatalogProduct) => product.game === game && product.kind === productKind;

	const productId = row.attributes["tcgplayer_product_id"];
	if (typeof productId === "number") {
		const product = await lookup.byProductId(productId);
		if (product !== null && fits(product)) return { status: "matched", product, by: "product_id" };
	}

	const setCode = text(row.attributes, "set_code");
	const number = text(row.attributes, "number");
	if (productKind === "single" && setCode !== null && number !== null) {
		const found = (await lookup.bySetAndNumber(game, setCode, number)).filter(fits);
		if (found.length === 1) return { status: "matched", product: found[0]!, by: "set_number" };
		if (found.length > 1) {
			return { status: "ambiguous", candidates: found.slice(0, MAX_CANDIDATES), by: "set_number" };
		}
	}

	const name = text(row.attributes, "name");
	if (name === null) return { status: "unmatched" };
	const found = (await lookup.byName(game, name, setCode)).filter((p) => fits(p) && sameSet(p, setCode));
	const exact = found.filter((product) => normalize(product.name) === normalize(name));
	if (exact.length === 1) return { status: "matched", product: exact[0]!, by: "name_set" };
	const ranked = (exact.length > 1 ? exact : found)
		.map((product) => ({ product, score: nameSimilarity(product.name, name) }))
		.filter(({ score }) => score >= MIN_SIMILARITY)
		.toSorted((a, b) => b.score - a.score)
		.map(({ product }) => product);
	if (ranked.length === 0) return { status: "unmatched" };
	return { status: "ambiguous", candidates: ranked.slice(0, MAX_CANDIDATES), by: "name_set" };
}
