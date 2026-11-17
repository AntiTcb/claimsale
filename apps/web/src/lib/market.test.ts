import { describe, expect, it } from "vitest";
import {
	marketSubtypes,
	pickMarketQuote,
	readAttributes,
	sellerMarketHint,
	type MarketPrice,
} from "./market.ts";

const prices: MarketPrice[] = [
	{ subtype: "1st Edition Holofoil", marketCents: 25_000, asOf: Date.UTC(2026, 9, 8) },
	{ subtype: "Unlimited Holofoil", marketCents: 9_000, asOf: Date.UTC(2026, 9, 8) },
	{ subtype: "Reverse Holofoil", marketCents: 1_240, asOf: Date.UTC(2026, 9, 8) },
	{ subtype: "Normal", marketCents: null, asOf: Date.UTC(2026, 9, 8) },
];

describe("market price aid", () => {
	it("maps finish and edition to TCGCSV subtypes, best match first", () => {
		expect(marketSubtypes({ finish: "holo", edition: "1st-edition" })).toEqual([
			"1st Edition Holofoil",
			"1st Edition",
			"Holofoil",
		]);
		expect(marketSubtypes({ edition: "1st" })).toEqual(["1st Edition"]);
		expect(marketSubtypes({ finish: "etched" })).toEqual(["Foil"]);
		expect(marketSubtypes({})).toEqual([]);
	});

	it("picks the price for the item's finish; without one, only a single priced subtype", () => {
		expect(pickMarketQuote(prices, { finish: "reverse-holo" })?.marketCents).toBe(1_240);
		expect(pickMarketQuote(prices, { finish: "holo", edition: "unlimited" })?.marketCents).toBe(9_000);
		expect(pickMarketQuote(prices, { finish: "non-holo" })).toBeNull(); // no market price for Normal
		expect(pickMarketQuote(prices, {})).toBeNull();
		expect(pickMarketQuote([prices[2]!], {})?.marketCents).toBe(1_240);
	});

	it("[TCG-market-placeholder] hints only catalogued singles and sealed, as a placeholder and buttons", () => {
		const attributes = { finish: "reverse-holo", tcgplayer_product_id: 42 };
		const hint = sellerMarketHint({ kind: "single", attributes, prices, defaultPercent: 80 });
		expect(hint).toMatchObject({ placeholder: "Market $12.40 · updated Oct 8", highlightedPercent: 80 });
		expect(hint?.presets.map((p) => [p.percent, p.priceCents])).toEqual([
			[70, 850],
			[75, 925],
			[80, 975],
			[85, 1050],
			[90, 1100],
			[100, 1225],
		]);
		expect(sellerMarketHint({ kind: "graded", attributes, prices, defaultPercent: null })).toBeNull();
		expect(
			sellerMarketHint({ kind: "single", attributes: { finish: "holo" }, prices, defaultPercent: null }),
		).toBeNull();
		expect(sellerMarketHint({ kind: "single", attributes, prices: null, defaultPercent: null })).toBeNull();
	});

	it("reads attribute JSON leniently", () => {
		expect(readAttributes('{"a":"x","n":2,"b":true,"o":{}}')).toEqual({ a: "x", n: 2, b: true });
		expect(readAttributes("not json")).toEqual({});
		expect(readAttributes("[1]")).toEqual({});
		expect(readAttributes("")).toEqual({});
	});
});
