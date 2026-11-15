// Pure unit tests for the TCGCSV mapping and the SQL builders (no I/O beyond prepare()).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	dollarsToCents,
	parseTcgCsvTime,
	productKind,
	sealedProductType,
	toPriceRow,
	toProductRow,
	toSetRow,
} from "../src/catalog/mapping.ts";
import { nameTier, searchWords, toFtsQuery } from "../src/catalog/search.ts";
import {
	chunk,
	MAX_PARAMS,
	priceStatements,
	productStatements,
	rowsPerStatement,
	setStatements,
} from "../src/catalog/store.ts";
import type { TcgCsvProduct } from "../src/catalog/tcgcsv.ts";
import products from "./fixtures/tcgcsv/products-89-24439.json";

const fixtureProducts = (products as { results: TcgCsvProduct[] }).results;
const byId = (id: number) => fixtureProducts.find((p) => p.productId === id)!;

describe("dollarsToCents", () => {
	it("converts TCGplayer dollar doubles to integer cents without float drift", () => {
		expect(dollarsToCents(4.25)).toBe(425);
		expect(dollarsToCents(0.35)).toBe(35);
		expect(dollarsToCents(12.4)).toBe(1240);
		expect(dollarsToCents(25.03)).toBe(2503);
		expect(dollarsToCents(1.005)).toBe(101);
		expect(dollarsToCents(0)).toBe(0);
	});

	it("treats missing or invalid prices as no price", () => {
		expect(dollarsToCents(null)).toBeNull();
		expect(dollarsToCents(undefined)).toBeNull();
		expect(dollarsToCents(Number.NaN)).toBeNull();
		expect(dollarsToCents(-1)).toBeNull();
		expect(dollarsToCents(Number.POSITIVE_INFINITY)).toBeNull();
	});
});

describe("parseTcgCsvTime", () => {
	it("reads last-updated.txt's offset without a colon", () => {
		expect(parseTcgCsvTime("2026-11-15T20:06:00+0000")).toBe(Date.parse("2026-11-15T20:06:00Z"));
		expect(parseTcgCsvTime("2026-11-15T22:06:00+0200")).toBe(Date.parse("2026-11-15T20:06:00Z"));
	});

	it("reads TCGplayer's zone-less timestamps as UTC", () => {
		expect(parseTcgCsvTime("2026-11-14T06:11:50.047")).toBe(Date.parse("2026-11-14T06:11:50.047Z"));
		expect(parseTcgCsvTime("2026-11-14T06:11:50Z")).toBe(Date.parse("2026-11-14T06:11:50Z"));
	});

	it("returns null for blanks and garbage", () => {
		expect(parseTcgCsvTime(null)).toBeNull();
		expect(parseTcgCsvTime("")).toBeNull();
		expect(parseTcgCsvTime("yesterday")).toBeNull();
	});
});

describe("product mapping", () => {
	it("maps a card to a single with its number and rarity, and nothing else [TCG-catalog-ingest]", () => {
		expect(toProductRow(byId(653136))).toEqual({
			tcgplayerProductId: 653136,
			kind: "single",
			name: "Annie, Fiery",
			number: "001/024",
			rarity: "Epic",
			productType: null,
		});
	});

	it("maps a product without number or rarity to sealed, with a product type from its name", () => {
		expect(toProductRow(byId(635460))).toMatchObject({
			kind: "sealed",
			number: null,
			rarity: null,
			productType: "Box Set",
		});
		expect(toProductRow(byId(663920))).toMatchObject({ kind: "sealed", productType: "Case" });
	});

	it("counts a rarity alone as a card", () => {
		const product = {
			productId: 1,
			groupId: 1,
			name: "X",
			extendedData: [{ name: "rarity", value: "Common" }],
		};
		expect(productKind(product)).toBe("single");
		expect(productKind({ productId: 1, groupId: 1, name: "X" })).toBe("sealed");
		expect(
			productKind({ productId: 1, groupId: 1, name: "X", extendedData: [{ name: "Number", value: " " }] }),
		).toBe("sealed");
	});

	it("collapses whitespace in names and falls back for a blank name", () => {
		expect(toProductRow({ productId: 7, groupId: 1, name: "  Tibbers,  Unleashed " }).name).toBe(
			"Tibbers, Unleashed",
		);
		expect(toProductRow({ productId: 7, groupId: 1, name: " " }).name).toBe("Product 7");
	});

	it.each([
		["Scarlet & Violet Booster Box Case", "Case"],
		["Surging Sparks Elite Trainer Box", "Elite Trainer Box"],
		["Origins Booster Box", "Booster Box"],
		["Origins Booster Pack", "Booster Pack"],
		["Duskmourn Collector Booster", "Booster Pack"],
		["Gift of the Rift Bundle", "Bundle"],
		["Annie Starter Deck", "Deck"],
		["Collector's Tin", "Tin"],
		["Origins - Proving Grounds Box Set", "Box Set"],
		["Premium Collection", "Collection"],
		["3-Pack Blister", "Blister"],
		["Booster Display", "Booster Box"],
		["Mystery Thing", null],
	])("classifies %s as %s", (name, type) => {
		expect(sealedProductType(name)).toBe(type);
	});
});

describe("set and price mapping", () => {
	it("maps a group to a set with its code and release date", () => {
		expect(
			toSetRow({
				groupId: 24439,
				name: "Origins: Proving Grounds",
				abbreviation: "OGS",
				publishedOn: "2025-10-31T00:00:00",
				categoryId: 89,
			}),
		).toEqual({
			tcgplayerGroupId: 24439,
			code: "OGS",
			name: "Origins: Proving Grounds",
			releaseDate: "2025-10-31",
		});
		expect(
			toSetRow({ groupId: 5, name: "X", abbreviation: "", publishedOn: null, categoryId: 1 }),
		).toMatchObject({
			code: null,
			releaseDate: null,
		});
	});

	it("maps a price row to cents and drops rows without a subtype", () => {
		expect(toPriceRow({ productId: 1, subTypeName: "Reverse Holofoil", marketPrice: 1.5 })).toEqual({
			tcgplayerProductId: 1,
			subtype: "Reverse Holofoil",
			marketCents: 150,
		});
		expect(toPriceRow({ productId: 1, subTypeName: "Normal", marketPrice: null })).toMatchObject({
			marketCents: null,
		});
		expect(toPriceRow({ productId: 1, subTypeName: " " })).toBeNull();
	});
});

describe("SQL batching", () => {
	it("keeps every statement under D1's 100 bound parameters", () => {
		expect(rowsPerStatement(9)).toBe(11);
		expect(rowsPerStatement(4)).toBe(25);
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		const product = toProductRow(byId(653136));
		const rows = Array.from({ length: 25 }, (_, i) => ({ ...product, tcgplayerProductId: i }));
		expect(productStatements(env.DB, "riftbound", 1, rows, 1)).toHaveLength(3);
		expect(
			priceStatements(
				env.DB,
				rows.map((r) => ({ tcgplayerProductId: r.tcgplayerProductId, subtype: "Normal", marketCents: 1 })),
				1,
			),
		).toHaveLength(1);
		expect(setStatements(env.DB, "riftbound", [], 1)).toHaveLength(0);
		expect(MAX_PARAMS).toBe(100);
	});
});

describe("search query building", () => {
	it("turns typed words into quoted prefix terms", () => {
		expect(toFtsQuery("Annie, Fiery")).toBe('"Annie"* "Fiery"*');
		expect(toFtsQuery("001/024")).toBe('"001"* "024"*');
	});

	it("never passes FTS syntax through", () => {
		expect(toFtsQuery('annie" OR name:* NEAR(')).toBe('"annie"* "OR"* "name"* "NEAR"*');
		expect(toFtsQuery("  --  ")).toBeNull();
		expect(toFtsQuery("a b c d e f g h i j")!.split(" ")).toHaveLength(8);
	});

	it("drops diacritics like the tokenizer does", () => {
		expect(searchWords("Pokémon Flabébé")).toEqual(["Pokemon", "Flabebe"]);
	});

	it("tiers names: exact, prefix, all words, other", () => {
		expect(nameTier("Annie, Fiery", ["annie", "fiery"])).toBe(0);
		expect(nameTier("Annie, Fiery (Alternate Art)", ["annie", "fiery"])).toBe(1);
		expect(nameTier("Annie, Fiery", ["annie", "fi"])).toBe(1);
		expect(nameTier("Riftbound Promo Booster Pack: Annie", ["annie"])).toBe(2);
		expect(nameTier("Firestorm", ["OGS", "002"])).toBe(3);
	});
});
