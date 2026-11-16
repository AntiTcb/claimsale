import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { expectOk } from "../testing.ts";
import { escapeFormula, formatCentsPlain, MAX_PRICE_CENTS, parseCents, unescapeFormula } from "./cells.ts";

describe("formula escaping [IO-export-formula-escape]", () => {
	it("prefixes cells that start with = + - @ tab or CR [IO-export-formula-escape]", () => {
		expect(escapeFormula('=HYPERLINK("http://evil","click")')).toBe(`'=HYPERLINK("http://evil","click")`);
		expect(escapeFormula("+1 555")).toBe("'+1 555");
		expect(escapeFormula("-2+3")).toBe("'-2+3");
		expect(escapeFormula("@SUM(A1)")).toBe("'@SUM(A1)");
		expect(escapeFormula("\t=1")).toBe("'\t=1");
		expect(escapeFormula("\r=1")).toBe("'\r=1");
	});

	it("leaves ordinary cells alone [IO-export-formula-escape]", () => {
		for (const cell of ["Charizard ex", "12.40", "", "a=b", "O'Brien", " =1"])
			expect(escapeFormula(cell)).toBe(cell);
	});

	it("no escaped cell starts with a formula character, and import undoes it exactly (property) [IO-export-formula-escape]", () => {
		const cell = fc.oneof(
			fc.string(),
			fc
				.tuple(fc.constantFrom("=", "+", "-", "@", "\t", "\r", "'", "''", "'="), fc.string())
				.map(([a, b]) => a + b),
		);
		fc.assert(
			fc.property(cell, (value) => {
				const escaped = escapeFormula(value);
				expect(escaped).not.toMatch(/^[=+\-@\t\r]/);
				expect(unescapeFormula(escaped)).toBe(value);
			}),
		);
	});
});

describe("money cells", () => {
	it("reads the common ways sellers write prices", () => {
		expect(expectOk(parseCents("12"))).toBe(1200);
		expect(expectOk(parseCents("12.4"))).toBe(1240);
		expect(expectOk(parseCents("$12.40"))).toBe(1240);
		expect(expectOk(parseCents(" 12,40 "))).toBe(1240);
		expect(expectOk(parseCents("1,234.56"))).toBe(123456);
		expect(expectOk(parseCents("1.234,56"))).toBe(123456);
		expect(expectOk(parseCents("0.05"))).toBe(5);
		expect(expectOk(parseCents("12.40 USD"))).toBe(1240);
	});

	it("rejects negatives, fractions of a cent, junk and huge amounts", () => {
		for (const bad of ["-1", "12.345", "abc", "", "1e3", "12.40.1", "1000000.01"]) {
			expect({ bad, ok: parseCents(bad).ok }).toEqual({ bad, ok: false });
		}
		expect(expectOk(parseCents("1000000"))).toBe(MAX_PRICE_CENTS);
	});

	it("refuses to format negative or fractional cents", () => {
		expect(() => formatCentsPlain(-1)).toThrow(RangeError);
		expect(() => formatCentsPlain(1.5)).toThrow(RangeError);
	});

	it("formats cents so parseCents reads them back (property)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: MAX_PRICE_CENTS }), (cents) => {
				expect(expectOk(parseCents(formatCentsPlain(cents)))).toBe(cents);
			}),
		);
	});
});
