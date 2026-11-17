/**
 * Multi-index hashing (PLAN "Photo authenticity", step 3): each 64-bit hash is stored as
 * 4 × 16-bit bands, and a stored image is a candidate when it shares a band value with
 * the upload. The full Hamming distance is then computed only for candidates.
 *
 * Recall: if two hashes differ in d bits, at least one band differs in ≤ ⌊d / 4⌋ bits.
 * Querying every band value within `radius` bits of the upload's band therefore finds
 * every stored hash with d ≤ 4·radius + 3: radius 0 → d ≤ 3, radius 1 → d ≤ 7, which
 * covers the reject distance (6). Matches in the review band (7–12) beyond that radius
 * are found only when some band happens to be closer.
 */
import type { HashKind, ImageHashes } from "./image.ts";
import { VARIANTS } from "./grid.ts";

export const BAND_COUNT = 4;
export const BAND_BITS = 16;

/** Band index 0 is the most significant 16 bits. */
export const BAND_INDEXES = [0, 1, 2, 3] as const;
export type BandIndex = (typeof BAND_INDEXES)[number];
export type Bands = readonly [number, number, number, number];

/** Splits a hash into its 4 bands (each 0..65535, safe as a D1 INTEGER). */
export function toBands(hash: bigint): Bands {
	return [
		Number((hash >> 48n) & 0xffffn),
		Number((hash >> 32n) & 0xffffn),
		Number((hash >> 16n) & 0xffffn),
		Number(hash & 0xffffn),
	];
}

/** Rebuilds a hash from its bands. */
export function fromBands(bands: Bands): bigint {
	return bands.reduce((acc, band) => (acc << 16n) | BigInt(band & 0xffff), 0n);
}

/** One indexed lookup key: rows with this (kind, band, value) are candidates. */
export interface BandKey {
	readonly kind: HashKind;
	readonly band: BandIndex;
	readonly value: number;
}

/** The 16-bit values within `radius` bits of `value` (radius 0 → 1 value, 1 → 17, 2 → 137). */
export function bandNeighbourhood(value: number, radius: 0 | 1 | 2): number[] {
	const out = [value];
	if (radius >= 1) {
		for (let i = 0; i < BAND_BITS; i++) out.push(value ^ (1 << i));
	}
	if (radius >= 2) {
		for (let i = 0; i < BAND_BITS; i++) {
			for (let j = i + 1; j < BAND_BITS; j++) out.push(value ^ (1 << i) ^ (1 << j));
		}
	}
	return out;
}

/**
 * The band keys to look up for an upload: every band of both hashes of all 5 variants
 * (so a mirrored or rotated copy of a stored original is found), widened to `radius`,
 * de-duplicated and in a stable order. Stored images only need their `orig` bands
 * indexed, since the variant set is closed under inverses (mirror ↔ mirror, r90 ↔ r270).
 *
 * Sizes: radius 0 → at most 40 keys, radius 1 → at most 680.
 */
export function candidateBands(hashes: ImageHashes, radius: 0 | 1 | 2 = 1): BandKey[] {
	const seen = new Set<string>();
	const out: BandKey[] = [];
	for (const kind of ["dhash", "phash"] as const) {
		for (const variant of VARIANTS) {
			const bands = toBands(hashes[variant][kind]);
			for (const band of BAND_INDEXES) {
				for (const value of bandNeighbourhood(bands[band], radius)) {
					const key = `${kind}:${band}:${value}`;
					if (seen.has(key)) continue;
					seen.add(key);
					out.push({ kind, band, value });
				}
			}
		}
	}
	return out;
}
