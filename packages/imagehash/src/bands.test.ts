import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bandNeighbourhood, type BandKey, candidateBands, fromBands, toBands } from "./bands.ts";
import { VARIANTS } from "./grid.ts";
import type { HashPair, ImageHashes } from "./image.ts";

const hash64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
const pairArb = fc.record({ dhash: hash64, phash: hash64 });
const hashesArb = fc
	.tuple(pairArb, pairArb, pairArb, pairArb, pairArb)
	.map((pairs) => Object.fromEntries(VARIANTS.map((v, i) => [v, pairs[i]!])) as ImageHashes);

/** Flips `count` distinct bits chosen by `positions`. */
const flipArb = (maxBits: number) =>
	fc.uniqueArray(fc.integer({ min: 0, max: 63 }), { minLength: 0, maxLength: maxBits });
const flip = (h: bigint, positions: number[]) => positions.reduce((acc, p) => acc ^ (1n << BigInt(p)), h);

/** What the index would hold for a stored image: its original's bands. */
function indexed(stored: HashPair): Set<string> {
	const keys = new Set<string>();
	for (const kind of ["dhash", "phash"] as const) {
		toBands(stored[kind]).forEach((value, band) => keys.add(`${kind}:${band}:${value}`));
	}
	return keys;
}
const hits = (keys: BandKey[], index: Set<string>) =>
	keys.some((k) => index.has(`${k.kind}:${k.band}:${k.value}`));

describe("bands", () => {
	it("splits a hash into 4 × 16-bit bands, most significant first, and back", () => {
		expect(toBands(0x0123_4567_89ab_cdefn)).toEqual([0x0123, 0x4567, 0x89ab, 0xcdef]);
		fc.assert(
			fc.property(hash64, (h) => {
				expect(fromBands(toBands(h))).toBe(h);
			}),
		);
	});

	it("enumerates the band values within a radius", () => {
		expect(bandNeighbourhood(0xabcd, 0)).toEqual([0xabcd]);
		const r1 = bandNeighbourhood(0, 1);
		expect(new Set(r1).size).toBe(17);
		const r2 = bandNeighbourhood(0xffff, 2);
		expect(new Set(r2).size).toBe(137);
		expect(r2.every((v) => v >= 0 && v <= 0xffff)).toBe(true);
	});
});

describe("candidateBands", () => {
	it("returns de-duplicated keys within the documented size", () => {
		fc.assert(
			fc.property(hashesArb, (hashes) => {
				for (const [radius, max] of [
					[0, 40],
					[1, 680],
				] as const) {
					const keys = candidateBands(hashes, radius);
					expect(keys.length).toBeLessThanOrEqual(max);
					expect(new Set(keys.map((k) => `${k.kind}:${k.band}:${k.value}`)).size).toBe(keys.length);
				}
			}),
		);
	});

	it("finds every stored original within 4·radius + 3 bits of any upload variant", () => {
		fc.assert(
			fc.property(
				hashesArb,
				fc.constantFrom(...VARIANTS),
				fc.constantFrom("dhash" as const, "phash" as const),
				fc.constantFrom(0 as const, 1 as const),
				flipArb(7),
				(upload, variant, kind, radius, positions) => {
					fc.pre(positions.length <= 4 * radius + 3);
					const near = flip(upload[variant][kind], positions);
					// The other hash is unrelated, so only `kind` can produce the hit.
					const stored = { dhash: 0n, phash: 0n, [kind]: near } as HashPair;
					const keys = candidateBands(upload, radius).filter((k) => k.kind === kind);
					expect(hits(keys, indexed(stored))).toBe(true);
				},
			),
		);
	});

	it("defaults to radius 1, which covers the reject distance", () => {
		const hashes = Object.fromEntries(VARIANTS.map((v) => [v, { dhash: 0n, phash: 0n }])) as ImageHashes;
		expect(candidateBands(hashes)).toEqual(candidateBands(hashes, 1));
		// All variants share their bands here: 2 kinds × 4 bands × 17 values.
		expect(candidateBands(hashes)).toHaveLength(136);
	});
});
