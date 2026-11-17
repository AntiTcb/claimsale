import { createDb, sql, type Db } from "@claimsale/db";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import {
	catalogLookup,
	catalogProductIdFor,
	defaultMarketPercent,
	marketPricesFor,
	matchRows,
	setDefaultMarketPercent,
} from "./catalog.ts";

let db: Db;

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	await db.run(sql`INSERT INTO catalog_sets (id, game_id, code, name, tcgplayer_group_id, updated_at)
		VALUES (1, 'pokemon', 'OBF', 'Obsidian Flames', 100, 1), (2, 'pokemon', 'PAF', 'Paldean Fates', 101, 1),
		       (3, 'final-fantasy', 'O1', 'Opus I', 102, 1)`);
	await db.run(sql`INSERT INTO catalog_products (id, game_id, set_id, kind, name, number, rarity, product_type, tcgplayer_product_id, updated_at)
		VALUES (1, 'pokemon', 1, 'single', 'Charizard ex', '125/197', 'Double Rare', NULL, 9001, 1),
		       (2, 'pokemon', 1, 'single', 'Charizard ex', '223/197', 'Special Illustration Rare', NULL, 9002, 1),
		       (3, 'pokemon', 2, 'single', 'Charizard ex', '054/091', 'Double Rare', NULL, 9003, 1),
		       (4, 'pokemon', 1, 'sealed', 'Obsidian Flames Booster Box', NULL, NULL, 'Booster Box', 9004, 1),
		       (5, 'final-fantasy', 3, 'single', 'Cloud', '1-182S', 'Legend', NULL, 9005, 1)`);
	await db.run(sql`INSERT INTO market_prices (product_id, subtype, market_cents, as_of)
		VALUES (1, 'Holofoil', 1240, 10), (1, 'Normal', NULL, 10), (4, 'Normal', 15000, 11)`);
});

describe("catalog reads", () => {
	it("looks products up by TCGplayer ID, set + number and name, enabled games only", async () => {
		const lookup = catalogLookup(db);
		expect(await lookup.byProductId(9001)).toMatchObject({
			name: "Charizard ex",
			setCode: "OBF",
			number: "125/197",
		});
		expect(await lookup.byProductId(9005)).toBeNull(); // Final Fantasy is disabled
		expect(await lookup.byProductId(1)).toBeNull();
		expect((await lookup.bySetAndNumber("pokemon", "obf", "125")).map((p) => p.tcgplayerProductId)).toEqual([
			9001,
		]);
		expect(
			(await lookup.byName("pokemon", "charizard", null))
				.map((p) => p.tcgplayerProductId)
				.toSorted((x, y) => x - y),
		).toEqual([9001, 9002, 9003]);
		expect((await lookup.byName("pokemon", "charizard", "PAF")).map((p) => p.tcgplayerProductId)).toEqual([
			9003,
		]);
		expect(await lookup.byName("pokemon", "!!!", null)).toEqual([]);
	});

	it("[TCG-catalog-match] matches rows by product ID, then set + number, then name; ambiguous names list candidates", async () => {
		const results = await matchRows(db, [
			{ row: 2, game: "pokemon", kind: "single", attributes: { tcgplayer_product_id: 9002, name: "x" } },
			{ row: 3, game: "pokemon", kind: "single", attributes: { set_code: "PAF", number: "054/091" } },
			{ row: 4, game: "pokemon", kind: "single", attributes: { name: "Charizard ex", set_code: "OBF" } },
			{ row: 5, game: "pokemon", kind: "sealed", attributes: { name: "Obsidian Flames Booster Box" } },
			{ row: 6, game: "pokemon", kind: "single", attributes: { name: "Pikachu" } },
			{ row: 7, game: null, kind: "accessory", attributes: {} },
		]);
		expect(results.map((r) => r.status)).toEqual([
			"matched",
			"matched",
			"ambiguous",
			"matched",
			"unmatched",
			"unmatched",
		]);
		expect(results[0]).toMatchObject({
			product: { productId: 2, tcgplayerProductId: 9002, setName: "Obsidian Flames" },
		});
		expect(results[1]).toMatchObject({ product: { productId: 3 } });
		const ambiguous = results[2]!;
		expect(
			ambiguous.status === "ambiguous" &&
				ambiguous.candidates.map((c) => c.productId).toSorted((x, y) => x - y),
		).toEqual([1, 2]);
		expect(results[3]).toMatchObject({
			product: { productId: 4, kind: "sealed", productType: "Booster Box" },
		});
	});

	it("[TCG-market-placeholder] reads market prices per product for the seller's own pages", async () => {
		const prices = await marketPricesFor(db, [1, 4, 4, 99, -1]);
		expect(prices.get(1)).toEqual([
			{ subtype: "Holofoil", marketCents: 1240, asOf: 10 },
			{ subtype: "Normal", marketCents: null, asOf: 10 },
		]);
		expect(prices.get(4)).toEqual([{ subtype: "Normal", marketCents: 15000, asOf: 11 }]);
		expect(prices.has(99)).toBe(false);
		expect((await marketPricesFor(db, [])).size).toBe(0);
	});

	it("resolves the linked catalog product from the attributes", async () => {
		expect(await catalogProductIdFor(db, { tcgplayer_product_id: 9004 })).toBe("4");
		expect(await catalogProductIdFor(db, { tcgplayer_product_id: 1 })).toBeNull();
		expect(await catalogProductIdFor(db, { tcgplayer_product_id: "9004" })).toBeNull();
	});

	it("saves the seller's default % of market, only as one of the buttons", async () => {
		expect(await defaultMarketPercent(db, "seller")).toBeNull();
		expect(await setDefaultMarketPercent(db, "seller", 80, 1)).toBe(true);
		expect(await defaultMarketPercent(db, "seller")).toBe(80);
		expect(await setDefaultMarketPercent(db, "seller", 83, 2)).toBe(false);
		expect(await defaultMarketPercent(db, "seller")).toBe(80);
		expect(await setDefaultMarketPercent(db, "seller", null, 3)).toBe(true);
		expect(await defaultMarketPercent(db, "seller")).toBeNull();
	});
});
