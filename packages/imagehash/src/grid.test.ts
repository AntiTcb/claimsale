import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type GrayGrid, resampleGray, rgbaToGray, transformGrid, type Variant, VARIANTS } from "./grid.ts";
import { applyEdit, syntheticImage } from "./testing/synthetic.ts";

const grayArb = fc
	.record({ w: fc.integer({ min: 1, max: 12 }), h: fc.integer({ min: 1, max: 12 }) })
	.chain(({ w, h }) =>
		fc
			.array(fc.double({ min: 0, max: 255, noNaN: true }), { minLength: w * h, maxLength: w * h })
			.map((values): GrayGrid => ({ width: w, height: h, data: Float64Array.from(values) })),
	);

const compose = (g: GrayGrid, ...vs: Variant[]) => vs.reduce(transformGrid, g);
const mean = (g: GrayGrid) => g.data.reduce((a, b) => a + b, 0) / g.data.length;

function expectClose(a: GrayGrid, b: GrayGrid, tolerance = 1e-9): void {
	expect([a.width, a.height]).toEqual([b.width, b.height]);
	for (let i = 0; i < a.data.length; i++) expect(Math.abs(a.data[i]! - b.data[i]!)).toBeLessThan(tolerance);
}

describe("rgbaToGray", () => {
	it("uses Rec. 601 luma and ignores alpha", () => {
		const data = new Uint8Array([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 128, 255, 255, 255, 255]);
		const g = rgbaToGray({ width: 4, height: 1, data }, 4, 1);
		expect(Array.from(g.data).map((v) => Math.round(v * 1000) / 1000)).toEqual([76.245, 149.685, 29.07, 255]);
	});

	it("area-averages blocks exactly when the ratio is whole", () => {
		const data = new Uint8Array(4 * 4 * 4);
		for (let i = 0; i < 16; i++) data.fill(i * 10, i * 4, i * 4 + 3);
		const g = rgbaToGray({ width: 4, height: 4, data }, 2, 2);
		// Top-left 2×2 block: pixels 0, 1, 4, 5 → (0 + 10 + 40 + 50) / 4.
		expect(Array.from(g.data).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([25, 45, 105, 125]);
	});

	it("rejects empty or short buffers", () => {
		expect(() => rgbaToGray({ width: 0, height: 1, data: new Uint8Array() }, 1, 1)).toThrow(RangeError);
		expect(() => rgbaToGray({ width: 2, height: 2, data: new Uint8Array(15) }, 1, 1)).toThrow(RangeError);
		expect(() => resampleGray({ width: 1.5, height: 1, data: new Float64Array(2) }, 1, 1)).toThrow(
			RangeError,
		);
	});
});

describe("resampleGray", () => {
	it("preserves the mean brightness for any size (shrinking or enlarging)", () => {
		fc.assert(
			fc.property(grayArb, fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), (g, w, h) => {
				expect(Math.abs(mean(resampleGray(g, w, h)) - mean(g))).toBeLessThan(1e-6);
			}),
		);
	});

	it("keeps a constant image constant", () => {
		const g: GrayGrid = { width: 7, height: 5, data: new Float64Array(35).fill(42) };
		for (const v of resampleGray(g, 3, 11).data) expect(v).toBeCloseTo(42, 9);
	});
});

describe("transformGrid", () => {
	it("forms the expected group: r90⁴ = mirror² = id, r90² = r180, r90³ = r270", () => {
		fc.assert(
			fc.property(grayArb, (g) => {
				expectClose(compose(g, "r90", "r90", "r90", "r90"), g);
				expectClose(compose(g, "mirror", "mirror"), g);
				expectClose(compose(g, "r90", "r90"), transformGrid(g, "r180"));
				expectClose(compose(g, "r90", "r90", "r90"), transformGrid(g, "r270"));
				expect(transformGrid(g, "orig")).toBe(g);
			}),
		);
	});

	it("rotates clockwise and mirrors left↔right", () => {
		// 2×1 grid [a b] → r90 is a 1×2 column [a; b] read top to bottom.
		const g: GrayGrid = { width: 2, height: 1, data: Float64Array.from([1, 2]) };
		expect(Array.from(transformGrid(g, "r90").data)).toEqual([1, 2]);
		expect(Array.from(transformGrid(g, "r270").data)).toEqual([2, 1]);
		expect(Array.from(transformGrid(g, "mirror").data)).toEqual([2, 1]);
		expect(transformGrid(g, "r90")).toMatchObject({ width: 1, height: 2 });
	});

	it("commutes with downscaling: transforming the working grid = transforming the photo", () => {
		const img = syntheticImage(7, 151, 97);
		const grid = rgbaToGray(img, 64, 64);
		for (const v of VARIANTS) {
			if (v === "orig") continue;
			const direct = rgbaToGray(applyEdit(img, v), 64, 64);
			expect(
				Array.from(transformGrid(grid, v).data, (x, i) => Math.abs(x - direct.data[i]!) < 1e-6),
			).not.toContain(false);
		}
	});
});
