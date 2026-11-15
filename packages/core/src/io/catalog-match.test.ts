import { describe, expect, it } from "vitest";
import type { CatalogProduct } from "../tcg.ts";
import { matchCatalog, nameSimilarity, type CatalogLookup } from "./catalog-match.ts";

const card = (
	id: number,
	name: string,
	setCode: string,
	number: string | null,
	game = "pokemon",
): CatalogProduct => ({
	tcgplayerProductId: id,
	game,
	kind: "single",
	name,
	setCode,
	setName: null,
	number,
	rarity: null,
	productType: null,
});

const CATALOG: readonly CatalogProduct[] = [
	card(1, "Charizard ex", "OBF", "125/197"),
	card(2, "Charizard ex", "OBF", "215/197"),
	card(3, "Charizard ex", "PAF", "54/91"),
	card(4, "Pikachu", "BS", "58/102"),
	card(5, "Pikachu", "JU", "60/64"),
	card(6, "Raichu", "BS", "14/102"),
	card(7, "Dark Magician", "LOB", "LOB-005", "yugioh"),
	card(8, "Dark Magician", "LOB", "LOB-005", "yugioh"),
	{ ...card(9, "Obsidian Flames Booster Box", "OBF", null), kind: "sealed", productType: "Booster Box" },
];

/** An in-memory lookup that records which steps ran. */
function lookup(calls: string[] = []): CatalogLookup {
	return {
		byProductId: (id) => {
			calls.push("product_id");
			return CATALOG.find((p) => p.tcgplayerProductId === id) ?? null;
		},
		bySetAndNumber: async (game, setCode, number) => {
			calls.push("set_number");
			return CATALOG.filter((p) => p.game === game && p.setCode === setCode && p.number === number);
		},
		byName: (game, name, setCode) => {
			calls.push("name_set");
			const first = name.toLowerCase().slice(0, 3);
			return CATALOG.filter(
				(p) =>
					p.game === game &&
					p.name.toLowerCase().includes(first) &&
					(setCode === null || p.setCode === setCode),
			);
		},
	};
}

const row = (
	attributes: Record<string, string | number>,
	kind: "single" | "graded" | "sealed" | "lot" = "single",
	game = "pokemon",
) => ({
	game,
	kind,
	attributes,
});

describe("catalog matching [TCG-catalog-match]", () => {
	it("matches by TCGplayer product ID first, without further lookups [TCG-catalog-match]", async () => {
		const calls: string[] = [];
		const match = await matchCatalog(row({ tcgplayer_product_id: 2, name: "Pikachu" }), lookup(calls));
		expect(match).toMatchObject({ status: "matched", by: "product_id", product: { tcgplayerProductId: 2 } });
		expect(calls).toEqual(["product_id"]);
	});

	it("falls through an unknown or other-game product ID to set + number [TCG-catalog-match]", async () => {
		const calls: string[] = [];
		const match = await matchCatalog(
			row({ tcgplayer_product_id: 7, set_code: "OBF", number: "125/197", name: "x" }),
			lookup(calls),
		);
		expect(match).toMatchObject({ status: "matched", by: "set_number", product: { tcgplayerProductId: 1 } });
		expect(calls).toEqual(["product_id", "set_number"]);
	});

	it("flags several printings under one set + number as ambiguous [TCG-catalog-match]", async () => {
		const match = await matchCatalog(
			row({ set_code: "LOB", number: "LOB-005" }, "single", "yugioh"),
			lookup(),
		);
		expect(match).toMatchObject({ status: "ambiguous", by: "set_number" });
		expect(match.status === "ambiguous" && match.candidates.map((p) => p.tcgplayerProductId)).toEqual([7, 8]);
	});

	it("then matches one exact name within the set [TCG-catalog-match]", async () => {
		const match = await matchCatalog(row({ set_code: "BS", number: "999", name: "pikachu" }), lookup());
		expect(match).toMatchObject({ status: "matched", by: "name_set", product: { tcgplayerProductId: 4 } });
	});

	it("lets the seller choose when the name fits several products, best first [TCG-catalog-match]", async () => {
		const match = await matchCatalog(row({ name: "Charizard ex" }), lookup());
		expect(match.status === "ambiguous" && match.candidates.map((p) => p.tcgplayerProductId)).toEqual([
			1, 2, 3,
		]);
		const fuzzy = await matchCatalog(row({ name: "Pikachuu", set_code: "BS" }), lookup());
		expect(fuzzy).toMatchObject({ status: "ambiguous", by: "name_set" });
		expect(fuzzy.status === "ambiguous" && fuzzy.candidates.map((p) => p.name)).toEqual(["Pikachu"]);
	});

	it("leaves unmatched rows uncatalogued [TCG-catalog-match]", async () => {
		expect(await matchCatalog(row({ name: "Zzyzx promo" }), lookup())).toEqual({ status: "unmatched" });
		expect(await matchCatalog(row({}), lookup())).toEqual({ status: "unmatched" });
		expect(await matchCatalog(row({ name: "Pikachu" }, "lot"), lookup())).toEqual({ status: "unmatched" });
	});

	it("matches sealed rows only to sealed products, and graded rows to singles [TCG-catalog-match]", async () => {
		expect(await matchCatalog(row({ tcgplayer_product_id: 9 }, "sealed"), lookup())).toMatchObject({
			status: "matched",
		});
		expect(await matchCatalog(row({ tcgplayer_product_id: 9 }, "single"), lookup())).toEqual({
			status: "unmatched",
		});
		expect(await matchCatalog(row({ tcgplayer_product_id: 4 }, "graded"), lookup())).toMatchObject({
			status: "matched",
		});
	});
});

describe("name similarity", () => {
	it("scores identical names 1 and unrelated names low", () => {
		expect(nameSimilarity("Charizard ex", "charizard EX")).toBe(1);
		expect(nameSimilarity("Pikachu", "Pikachuu")).toBeGreaterThan(0.8);
		expect(nameSimilarity("Pikachu", "Raichu")).toBeLessThan(0.5);
		expect(nameSimilarity("", "")).toBe(1);
	});
});
