import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MARKET_PERCENT_PRESETS, MIN_SUGGESTED_PRICE, formatCents, priceFromMarketPercent } from "./money.ts";

describe("formatCents", () => {
	it("formats whole and fractional dollars", () => {
		expect(formatCents(0)).toBe("$0.00");
		expect(formatCents(1240)).toBe("$12.40");
		expect(formatCents(123456)).toBe("$1,234.56");
	});

	it("rejects non-integer cents", () => {
		expect(() => formatCents(1.5)).toThrow(RangeError);
	});
});

describe("priceFromMarketPercent [TCG-market-pct]", () => {
	it("applies 80% of a $12.40 market and rounds down to $0.25 [TCG-market-pct]", () => {
		// 80% of 1240 = 992 → $9.92 → $9.75
		expect(priceFromMarketPercent(1240, 80)).toBe(975);
	});

	it("rounds down to $0.05 below $5 [TCG-market-pct]", () => {
		// 80% of 399 = 319.2 → 319 → $3.15
		expect(priceFromMarketPercent(399, 80)).toBe(315);
	});

	it("uses the $0.25 step from exactly $5 [TCG-market-pct]", () => {
		expect(priceFromMarketPercent(500, 100)).toBe(500);
		expect(priceFromMarketPercent(624, 100)).toBe(600);
	});

	it("never suggests less than the minimum price [TCG-market-pct]", () => {
		expect(priceFromMarketPercent(3, 70)).toBe(MIN_SUGGESTED_PRICE);
	});

	it("rejects invalid inputs [TCG-market-pct]", () => {
		expect(() => priceFromMarketPercent(0, 80)).toThrow(RangeError);
		expect(() => priceFromMarketPercent(1000, 0)).toThrow(RangeError);
		expect(() => priceFromMarketPercent(1000, 101)).toThrow(RangeError);
		expect(() => priceFromMarketPercent(1000, 80.5)).toThrow(RangeError);
	});

	it("is never above the exact percentage, lands on its step, and is monotonic [TCG-market-pct]", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 10_000_000 }),
				fc.constantFrom(...MARKET_PERCENT_PRESETS),
				(market, pct) => {
					const price = priceFromMarketPercent(market, pct);
					const exact = (market * pct) / 100;
					expect(price).toBeGreaterThanOrEqual(MIN_SUGGESTED_PRICE);
					expect(price).toBeLessThanOrEqual(Math.max(exact, MIN_SUGGESTED_PRICE));
					expect(price % (price < 500 ? 5 : 25)).toBe(0);
					expect(priceFromMarketPercent(market + 1, pct)).toBeGreaterThanOrEqual(price);
				},
			),
		);
	});
});
