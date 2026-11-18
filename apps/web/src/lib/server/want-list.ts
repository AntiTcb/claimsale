import {
	CONDITION_LABELS,
	CONDITIONS,
	FINISH_LABELS,
	gameBySlug,
	LANGUAGE_LABELS,
	ok,
	reject,
	type Millis,
	type Rejection,
	type Result,
} from "@claimsale/core";
import { and, desc, eq, sql, type Db } from "@claimsale/db";
import { catalogProducts, catalogSets, wantListItems } from "@claimsale/db/catalog";
import { uuidv7 } from "uuidv7";
import { parsePrice } from "#lib/listing-input.ts";

/**
 * Want lists (D61): a buyer saves catalog products with an optional finish, minimum
 * condition, language and maximum price; the engine tells them when a public sale lists
 * a match (`TCG-want-list-notify`).
 */

export const WANT_LIST_MAX = 200;

export interface WantInput {
	readonly productId: string;
	readonly finish: string;
	readonly minCondition: string;
	readonly language: string;
	readonly maxPrice: string;
}

export type WantRejection = Rejection<"not_found" | "invalid" | "full">;

export interface WantView {
	readonly id: string;
	readonly productId: number;
	readonly name: string;
	readonly setName: string;
	readonly number: string | null;
	readonly game: string;
	readonly finish: string | null;
	readonly minCondition: string | null;
	readonly language: string | null;
	readonly maxPriceCents: number | null;
}

export async function listWants(db: Db, userId: string): Promise<WantView[]> {
	return db
		.select({
			id: wantListItems.id,
			productId: wantListItems.productId,
			name: catalogProducts.name,
			setName: catalogSets.name,
			number: catalogProducts.number,
			game: catalogProducts.gameId,
			finish: wantListItems.finish,
			minCondition: wantListItems.minCondition,
			language: wantListItems.language,
			maxPriceCents: wantListItems.maxPriceCents,
		})
		.from(wantListItems)
		.innerJoin(catalogProducts, eq(catalogProducts.id, wantListItems.productId))
		.innerJoin(catalogSets, eq(catalogSets.id, catalogProducts.setId))
		.where(eq(wantListItems.userId, userId))
		.orderBy(desc(wantListItems.createdAt), desc(wantListItems.id))
		.all();
}

const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());

/** Validates and saves a want-list entry against the product's game (its finishes and languages). */
export async function addWant(
	db: Db,
	userId: string,
	input: WantInput,
	now: Millis,
): Promise<Result<{ id: string }, WantRejection>> {
	const productId = Number(input.productId);
	if (!Number.isSafeInteger(productId)) return reject("not_found", "Pick a card from the search results");
	const product = await db
		.select({ id: catalogProducts.id, gameId: catalogProducts.gameId })
		.from(catalogProducts)
		.where(eq(catalogProducts.id, productId))
		.get();
	if (!product) return reject("not_found", "Pick a card from the search results");
	const game = gameBySlug(product.gameId);
	const finish = blankToNull(input.finish);
	const minCondition = blankToNull(input.minCondition);
	const language = blankToNull(input.language);
	const finishes: readonly string[] = game?.finishes ?? Object.keys(FINISH_LABELS);
	const languages: readonly string[] = game?.languages ?? Object.keys(LANGUAGE_LABELS);
	if (finish !== null && !finishes.includes(finish))
		return reject("invalid", "That finish doesn't exist for this game");
	if (minCondition !== null && !(CONDITIONS as readonly string[]).includes(minCondition))
		return reject("invalid", "Pick a condition from the list");
	if (language !== null && !languages.includes(language))
		return reject("invalid", "That language doesn't exist for this game");
	let maxPriceCents: number | null = null;
	if (input.maxPrice.trim() !== "") {
		const parsed = parsePrice(input.maxPrice);
		if (!parsed.ok) return reject("invalid", parsed.message);
		maxPriceCents = parsed.value;
	}
	const count = await db
		.select({ n: sql<number>`count(*)` })
		.from(wantListItems)
		.where(eq(wantListItems.userId, userId))
		.get();
	if ((count?.n ?? 0) >= WANT_LIST_MAX)
		return reject("full", `A want list holds at most ${WANT_LIST_MAX} cards`);
	const id = uuidv7();
	await db
		.insert(wantListItems)
		.values({ id, userId, productId, finish, minCondition, language, maxPriceCents, createdAt: now });
	return ok({ id });
}

export async function removeWant(db: Db, userId: string, id: string): Promise<void> {
	await db.delete(wantListItems).where(and(eq(wantListItems.id, id), eq(wantListItems.userId, userId)));
}

/** Labels for the form and the list. */
export const WANT_LABELS = { CONDITION_LABELS, FINISH_LABELS, LANGUAGE_LABELS } as const;
