import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type GrayGrid, rgbaToGray } from "./grid.ts";
import { dHash, hammingDistance, hashFromHex, hashToHex, pHash } from "./hash.ts";
import { syntheticImage } from "./testing/synthetic.ts";

const hash64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });

function naivePopcount(x: bigint): number {
	return x.toString(2).replaceAll("0", "").length;
}

/** A 64×64 horizontal ramp, brightest on the left when `descending`. */
function ramp(descending: boolean): GrayGrid {
	const data = new Float64Array(64 * 64);
	for (let y = 0; y < 64; y++)
		for (let x = 0; x < 64; x++) data[y * 64 + x] = descending ? 255 - x * 4 : x * 4;
	return { width: 64, height: 64, data };
}

describe("hammingDistance", () => {
	it("counts differing bits, is symmetric and satisfies the triangle inequality", () => {
		fc.assert(
			fc.property(hash64, hash64, hash64, (a, b, c) => {
				expect(hammingDistance(a, b)).toBe(naivePopcount(a ^ b));
				expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
				expect(hammingDistance(a, a)).toBe(0);
				expect(hammingDistance(a, c)).toBeLessThanOrEqual(hammingDistance(a, b) + hammingDistance(b, c));
			}),
		);
	});

	it("spans 0..64", () => {
		expect(hammingDistance(0n, (1n << 64n) - 1n)).toBe(64);
	});
});

describe("hex encoding", () => {
	it("round-trips any 64-bit hash as 16 lowercase hex characters", () => {
		fc.assert(
			fc.property(hash64, (h) => {
				const hex = hashToHex(h);
				expect(hex).toMatch(/^[0-9a-f]{16}$/);
				expect(hashFromHex(hex)).toBe(h);
			}),
		);
	});

	it("rejects values outside 64 bits and malformed hex", () => {
		expect(() => hashToHex(-1n)).toThrow(RangeError);
		expect(() => hashToHex(1n << 64n)).toThrow(RangeError);
		expect(() => hashFromHex("abc")).toThrow(RangeError);
		expect(() => hashFromHex("ABCDEFABCDEFABCD")).toThrow(RangeError);
	});
});

describe("dHash", () => {
	it("sets a bit when the left cell is brighter (most significant bit first)", () => {
		expect(dHash(ramp(true))).toBe((1n << 64n) - 1n);
		expect(dHash(ramp(false))).toBe(0n);
	});
});

describe("pHash", () => {
	it("is identical for a uniform brightness shift and far for an inverted image", () => {
		const base = rgbaToGray(syntheticImage(11, 200, 150), 64, 64);
		const shifted: GrayGrid = { ...base, data: base.data.map((v) => v + 30) };
		const inverted: GrayGrid = { ...base, data: base.data.map((v) => 255 - v) };
		expect(pHash(shifted)).toBe(pHash(base));
		expect(hammingDistance(pHash(base), pHash(inverted))).toBeGreaterThan(20);
	});

	it("sets 32 bits above the median for an image with distinct coefficients", () => {
		const data = new Float64Array(64 * 64);
		for (let i = 0; i < data.length; i++) data[i] = (Math.sin(i * 12.9898) * 43758.5453) % 255;
		const h = pHash({ width: 64, height: 64, data });
		expect(hammingDistance(h, 0n)).toBe(32);
	});
});
