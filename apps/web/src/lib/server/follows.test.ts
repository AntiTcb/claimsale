import { createDb, type Db } from "@claimsale/db";
import { catalogProducts, catalogSets } from "@claimsale/db/catalog";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { follow, followerCount, isFollowing, unfollow, userIdByHandle } from "./follows.ts";
import { addWant, listWants, removeWant, WANT_LIST_MAX } from "./want-list.ts";

let db: Db;

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "ash", { handle: "ash" });
	await addUser(db, "brock", { handle: "brock" });
});

describe("follows (D41)", () => {
	it("[SM-2-go-live-alarm] a buyer follows a seller once, and can unfollow", async () => {
		expect(await userIdByHandle(db, "BROCK")).toBe("brock");
		expect(await userIdByHandle(db, "nobody")).toBeUndefined();
		expect(await follow(db, "ash", "brock", 1)).toEqual({ ok: true, value: true });
		expect(await follow(db, "ash", "brock", 2)).toEqual({ ok: true, value: true });
		expect(await isFollowing(db, "ash", "brock")).toBe(true);
		expect(await followerCount(db, "brock")).toBe(1);
		await unfollow(db, "ash", "brock");
		expect(await isFollowing(db, "ash", "brock")).toBe(false);
		expect(await followerCount(db, "brock")).toBe(0);
	});

	it("nobody follows themselves", async () => {
		expect(await follow(db, "ash", "ash", 1)).toMatchObject({ ok: false, error: { code: "self" } });
	});
});

describe("want list (D61)", () => {
	let productId: number;

	beforeEach(async () => {
		const set = await db
			.insert(catalogSets)
			.values({ gameId: "pokemon", code: "BS", name: "Base Set", tcgplayerGroupId: 604, updatedAt: 1 })
			.returning()
			.get();
		const product = await db
			.insert(catalogProducts)
			.values({
				gameId: "pokemon",
				setId: set.id,
				kind: "single",
				name: "Charizard",
				number: "4/102",
				tcgplayerProductId: 42_000,
				updatedAt: 1,
			})
			.returning()
			.get();
		productId = product.id;
	});

	const input = (over: Partial<Parameters<typeof addWant>[2]> = {}) => ({
		productId: String(productId),
		finish: "holo",
		minCondition: "LP",
		language: "en",
		maxPrice: "250",
		...over,
	});

	it("[TCG-want-list-notify] saves a catalog product with its filters, checked against the game", async () => {
		expect((await addWant(db, "ash", input(), 1)).ok).toBe(true);
		expect(await listWants(db, "ash")).toEqual([
			expect.objectContaining({
				productId,
				name: "Charizard",
				setName: "Base Set",
				finish: "holo",
				minCondition: "LP",
				language: "en",
				maxPriceCents: 25_000,
			}),
		]);
		const blank = await addWant(
			db,
			"ash",
			input({ finish: "", minCondition: "", language: "", maxPrice: "" }),
			2,
		);
		expect(blank.ok).toBe(true);
		expect((await listWants(db, "ash"))[0]).toMatchObject({ finish: null, maxPriceCents: null });
	});

	it("rejects unknown products, finishes, languages, conditions and prices", async () => {
		expect(await addWant(db, "ash", input({ productId: "999" }), 1)).toMatchObject({
			error: { code: "not_found" },
		});
		expect(await addWant(db, "ash", input({ productId: "x" }), 1)).toMatchObject({
			error: { code: "not_found" },
		});
		expect(await addWant(db, "ash", input({ finish: "etched" }), 1)).toMatchObject({
			error: { code: "invalid" },
		});
		expect(await addWant(db, "ash", input({ language: "ru" }), 1)).toMatchObject({
			error: { code: "invalid" },
		});
		expect(await addWant(db, "ash", input({ minCondition: "Mint" }), 1)).toMatchObject({
			error: { code: "invalid" },
		});
		expect(await addWant(db, "ash", input({ maxPrice: "-3" }), 1)).toMatchObject({
			error: { code: "invalid" },
		});
		expect(await listWants(db, "ash")).toEqual([]);
	});

	it("removes only the owner's entry and caps the list", async () => {
		const added = await addWant(db, "ash", input(), 1);
		const id = added.ok ? added.value.id : "";
		await removeWant(db, "brock", id);
		expect(await listWants(db, "ash")).toHaveLength(1);
		await removeWant(db, "ash", id);
		expect(await listWants(db, "ash")).toEqual([]);
		for (let i = 0; i < WANT_LIST_MAX; i++) await addWant(db, "brock", input(), i);
		expect(await addWant(db, "brock", input(), 999)).toMatchObject({ error: { code: "full" } });
	});
});
