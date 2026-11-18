import { parseItemFilters } from "@claimsale/core";
import { createDb, eq, type Db } from "@claimsale/db";
import { catalogProducts, catalogSets } from "@claimsale/db/catalog";
import { itemAttributes, itemImages, items, sales, users } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import {
	gameFacets,
	itemCountsByGame,
	listGameItems,
	listSales,
	search,
	sitemapSales,
	whoHas,
} from "./discovery.ts";

let db: Db;
let charizard: number;
const HOUR = 3_600_000;

type SaleOver = Partial<typeof sales.$inferInsert>;
type ItemOver = Partial<typeof items.$inferInsert> & { attrs?: Record<string, string> };

async function addSale(id: string, over: SaleOver = {}) {
	await db.insert(sales).values({
		id,
		sellerId: "misty",
		slug: id,
		title: `Sale ${id}`,
		visibility: "public",
		status: "live",
		liveAt: 10 * HOUR,
		closesAt: 20 * HOUR,
		createdAt: 1,
		updatedAt: 1,
		...over,
	});
}

let order = 0;
async function addItem(id: string, saleId: string, over: ItemOver = {}) {
	const { attrs = {}, ...rest } = over;
	order += 1;
	await db.insert(items).values({
		id,
		saleId,
		sortOrder: order,
		gameId: "pokemon",
		title: `Item ${id}`,
		priceCents: 1000,
		createdAt: order,
		updatedAt: order,
		...rest,
	});
	for (const [key, valueText] of Object.entries(attrs))
		await db.insert(itemAttributes).values({ itemId: id, key, valueText });
}

const filters = (query = "") => parseItemFilters(new URLSearchParams(query));
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((x) => x.id);

beforeEach(async () => {
	order = 0;
	db = createDb(testD1());
	await addUser(db, "misty", { handle: "misty" });
	await addUser(db, "brock", { handle: "brock" });
	const set = await db
		.insert(catalogSets)
		.values({ gameId: "pokemon", code: "OBF", name: "Obsidian Flames", tcgplayerGroupId: 1, updatedAt: 1 })
		.returning()
		.get();
	charizard = (
		await db
			.insert(catalogProducts)
			.values({
				gameId: "pokemon",
				setId: set.id,
				kind: "single",
				name: "Charizard ex",
				number: "125/197",
				rarity: "Double Rare",
				tcgplayerProductId: 509_000,
				updatedAt: 1,
			})
			.returning()
			.get()
	).id;

	await addSale("live-1", { closesAt: 30 * HOUR });
	await addSale("live-2", { closesAt: 15 * HOUR, sellerId: "brock" });
	await addSale("soon", { status: "scheduled", liveAt: 50 * HOUR, closesAt: 60 * HOUR });
	await addSale("unlisted", { visibility: "unlisted" });
	await addSale("private", { visibility: "private" });
	await addSale("draft", { status: "draft" });
	await addSale("closed", { status: "closed" });
}, 20_000);

describe("discovery", () => {
	it("[DISC-public-only] lists only public scheduled and live sales, and never withdrawn items", async () => {
		for (const sale of ["live-1", "live-2", "soon", "unlisted", "private", "draft", "closed"])
			await addItem(`${sale}-card`, sale, { title: "Charizard ex", catalogProductId: String(charizard) });
		await addItem("pulled", "live-1", {
			title: "Charizard ex",
			state: "withdrawn",
			catalogProductId: String(charizard),
		});

		expect(ids(await listSales(db, { order: "live" }))).toEqual(["live-2", "live-1"]);
		expect(ids(await listSales(db, { order: "upcoming" }))).toEqual(["soon"]);
		expect(ids((await listGameItems(db, "pokemon", filters())).items)).toEqual([
			"live-2-card",
			"live-1-card",
			"soon-card",
		]);
		const found = await search(db, "charizard");
		expect(ids(found.items).toSorted()).toEqual(["live-1-card", "live-2-card", "soon-card"]);
		expect(found.products).toEqual([expect.objectContaining({ productId: charizard, listings: 3 })]);
		expect(ids((await whoHas(db, charizard))!.listings).toSorted()).toEqual([
			"live-1-card",
			"live-2-card",
			"soon-card",
		]);
		expect((await sitemapSales(db)).map((s) => s.slug).toSorted()).toEqual(["live-1", "live-2", "soon"]);
		expect(await itemCountsByGame(db)).toEqual(new Map([["pokemon", 3]]));
		// A banned seller's sales disappear from discovery too.
		await db
			.update(users)
			.set({ bannedAt: new Date(5) })
			.where(eq(users.id, "brock"));
		expect(ids(await listSales(db, { order: "live" }))).toEqual(["live-1"]);
	});

	it("[DISC-public-only] sends buyer-facing fields only, with the first approved photo", async () => {
		await addItem("card", "live-1", { minOfferCents: 500, sku: "SECRET-SKU", offersMode: "on_min" });
		await db.insert(itemImages).values([
			{
				id: "img-pending",
				saleId: "live-1",
				itemId: "card",
				sellerId: "misty",
				r2Key: "a",
				contentType: "image/webp",
				bytes: 1,
				sortOrder: 0,
				status: "pending",
				createdAt: 1,
			},
			{
				id: "img-ok",
				saleId: "live-1",
				itemId: "card",
				sellerId: "misty",
				r2Key: "b",
				contentType: "image/webp",
				bytes: 1,
				sortOrder: 1,
				status: "approved",
				createdAt: 1,
			},
		]);
		const [card] = (await listGameItems(db, "pokemon", filters())).items;
		expect(card).toMatchObject({ id: "card", imageId: "img-ok", saleSlug: "live-1", sellerHandle: "misty" });
		const text = JSON.stringify(card);
		expect(text).not.toContain("SECRET-SKU");
		expect(text).not.toContain("500");
		expect(Object.keys(card!)).not.toContain("minOfferCents");
		expect((await listSales(db, { order: "live" })).find((sale) => sale.id === "live-1")).toMatchObject({
			id: "live-1",
			imageId: "img-ok",
			itemCount: 1,
		});
	});

	it("filters a game's items by kind, condition, set, rarity, language, finish and price, and sorts them", async () => {
		await addItem("nm-cheap", "live-1", {
			condition: "NM",
			priceCents: 500,
			attrs: { set_name: "Obsidian Flames", rarity: "Double Rare", language: "en", finish: "holo" },
		});
		await addItem("lp-mid", "live-2", {
			condition: "LP",
			priceCents: 2500,
			attrs: { set_name: "Obsidian Flames", rarity: "Rare", language: "ja" },
		});
		await addItem("graded", "soon", { kind: "graded", priceCents: 90_000, attrs: { set_name: "Base Set" } });
		await addItem("mtg", "live-1", { gameId: "mtg", priceCents: 100 });

		const list = async (query: string) => ids((await listGameItems(db, "pokemon", filters(query))).items);
		expect(await list("kind=graded")).toEqual(["graded"]);
		expect(await list("condition=NM&condition=LP&sort=price_asc")).toEqual(["nm-cheap", "lp-mid"]);
		expect(await list("set=Obsidian+Flames&rarity=Rare")).toEqual(["lp-mid"]);
		expect(await list("language=en")).toEqual(["nm-cheap"]);
		expect(await list("finish=holo")).toEqual(["nm-cheap"]);
		expect(await list("min=10&max=1000")).toEqual(["lp-mid", "graded"]);
		expect(await list("sort=price_desc")).toEqual(["graded", "lp-mid", "nm-cheap"]);
		// Live sales first, the one closing soonest on top; then upcoming ones.
		expect(await list("")).toEqual(["lp-mid", "nm-cheap", "graded"]);
		expect(await list("sort=starting")).toEqual(["graded", "nm-cheap", "lp-mid"]);

		expect(await gameFacets(db, "pokemon")).toEqual({
			sets: ["Obsidian Flames", "Base Set"],
			rarities: ["Double Rare", "Rare"],
			languages: ["en", "ja"],
			finishes: ["holo"],
		});
	});

	it("pages through a game's items", async () => {
		for (let n = 0; n < 50; n++)
			await addItem(`i${String(n).padStart(2, "0")}`, "live-1", { priceCents: 100 + n });
		const first = await listGameItems(db, "pokemon", filters("sort=price_asc"));
		const second = await listGameItems(db, "pokemon", filters("sort=price_asc&page=2"));
		expect([first.items.length, first.hasMore, second.items.length, second.hasMore]).toEqual([
			48,
			true,
			2,
			false,
		]);
		expect(ids(second.items)).toEqual(["i48", "i49"]);
	}, 20_000);

	it("searches item and sale titles word by word, treating LIKE wildcards as text", async () => {
		await addItem("a", "live-1", { title: "Pikachu Illustrator 100% real" });
		await addItem("b", "live-2", { title: "Pikachu V" });
		await db.update(sales).set({ title: "Pikachu weekend" }).where(eq(sales.id, "soon"));
		expect(ids((await search(db, "pikachu")).items).toSorted()).toEqual(["a", "b"]);
		expect(ids((await search(db, "PIKACHU illustrator")).items)).toEqual(["a"]);
		expect(ids((await search(db, "pikachu")).sales)).toEqual(["soon"]);
		expect((await search(db, "%")).terms).toEqual([]);
		expect(ids((await search(db, "100_")).items)).toEqual(["a"]);
		expect(ids((await search(db, "pikachu", "mtg")).items)).toEqual([]);
	});

	it("[DISC-who-has] lists a catalog product's listings, available ones first, then cheapest", async () => {
		const card = { title: "Charizard ex", catalogProductId: String(charizard) };
		await addItem("pricey", "live-1", { ...card, priceCents: 9000 });
		await addItem("cheap", "live-2", { ...card, priceCents: 7000 });
		await addItem("gone", "live-2", { ...card, priceCents: 100, state: "sold_out" });
		await addItem("upcoming", "soon", { ...card, priceCents: 8000 });
		await addItem("other", "live-1", { title: "Charizard ex (proxy)" });
		const result = await whoHas(db, charizard);
		expect(result?.product).toMatchObject({
			name: "Charizard ex",
			setName: "Obsidian Flames",
			number: "125/197",
		});
		expect(ids(result!.listings)).toEqual(["cheap", "upcoming", "pricey", "gone"]);
		expect(await whoHas(db, 999_999)).toBeNull();
		expect((await search(db, "chariz")).products).toEqual([
			expect.objectContaining({
				productId: charizard,
				listings: 4,
				fromCents: 100,
				setName: "Obsidian Flames",
			}),
		]);
	});
});
