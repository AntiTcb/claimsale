/**
 * 64-bit perceptual hashes (dHash, pHash) and Hamming distance.
 *
 * Representation: an unsigned 64-bit `bigint` (0 ≤ h < 2^64). Bit 63 (the most
 * significant) is the first cell in row-major order. A bigint keeps the hash one value
 * that compares with `===` and XORs in one step; `hashToHex` / `hashFromHex` give a fixed
 * 16-character form for storage, because D1 returns INTEGER columns as JS numbers and
 * would lose bits above 2^53.
 */
import { type GrayGrid, resampleGray } from "./grid.ts";

const MASK64 = (1n << 64n) - 1n;

/** Packs 64 booleans (index 0 = most significant bit) into a bigint via two u32 halves. */
function packBits(bits: (i: number) => boolean): bigint {
	let hi = 0;
	let lo = 0;
	for (let i = 0; i < 32; i++) {
		hi = ((hi << 1) | (bits(i) ? 1 : 0)) >>> 0;
		lo = ((lo << 1) | (bits(i + 32) ? 1 : 0)) >>> 0;
	}
	return (BigInt(hi) << 32n) | BigInt(lo);
}

/**
 * dHash: area-average to 9×8, then one bit per adjacent pair in each row,
 * set when the left cell is brighter than the right one.
 */
export function dHash(grid: GrayGrid): bigint {
	const g = resampleGray(grid, 9, 8);
	return packBits((i) => {
		const row = Math.floor(i / 8);
		const col = i % 8;
		return g.data[row * 9 + col]! > g.data[row * 9 + col + 1]!;
	});
}

const DCT_N = 32;
const DCT_K = 8;

/** cos((2x+1)uπ / 2N) for the first DCT_K frequencies, computed once. */
const DCT_COS: Float64Array = (() => {
	const table = new Float64Array(DCT_K * DCT_N);
	for (let u = 0; u < DCT_K; u++) {
		for (let x = 0; x < DCT_N; x++) {
			table[u * DCT_N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * DCT_N));
		}
	}
	return table;
})();

/**
 * pHash: area-average to 32×32, take the 2-D DCT-II, keep the 8×8 lowest frequencies
 * (DC included) and set a bit for each coefficient above their median.
 * Only the 8 lowest frequencies are computed in each direction.
 */
export function pHash(grid: GrayGrid): bigint {
	const g = resampleGray(grid, DCT_N, DCT_N).data;
	// Rows: 32 rows × 8 frequencies.
	const rowDct = new Float64Array(DCT_N * DCT_K);
	for (let y = 0; y < DCT_N; y++) {
		for (let u = 0; u < DCT_K; u++) {
			let sum = 0;
			for (let x = 0; x < DCT_N; x++) sum += g[y * DCT_N + x]! * DCT_COS[u * DCT_N + x]!;
			rowDct[y * DCT_K + u] = sum;
		}
	}
	// Columns: 8 × 8 coefficients, index v * 8 + u.
	const coeffs = new Float64Array(DCT_K * DCT_K);
	for (let v = 0; v < DCT_K; v++) {
		for (let u = 0; u < DCT_K; u++) {
			let sum = 0;
			for (let y = 0; y < DCT_N; y++) sum += rowDct[y * DCT_K + u]! * DCT_COS[v * DCT_N + y]!;
			coeffs[v * DCT_K + u] = sum;
		}
	}
	const sorted = coeffs.toSorted();
	const median = (sorted[31]! + sorted[32]!) / 2;
	return packBits((i) => coeffs[i]! > median);
}

/** Number of differing bits between two 64-bit hashes (0..64). */
export function hammingDistance(a: bigint, b: bigint): number {
	const x = (a ^ b) & MASK64;
	return popcount32(Number(x >> 32n)) + popcount32(Number(x & 0xffffffffn));
}

function popcount32(n: number): number {
	let v = n >>> 0;
	v = v - ((v >>> 1) & 0x55555555);
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Fixed-width lowercase hex (16 characters). */
export function hashToHex(hash: bigint): string {
	if (hash < 0n || hash > MASK64) throw new RangeError("Not an unsigned 64-bit hash");
	return hash.toString(16).padStart(16, "0");
}

export function hashFromHex(hex: string): bigint {
	if (!/^[0-9a-f]{16}$/.test(hex)) throw new RangeError("Expected 16 lowercase hex characters");
	return BigInt(`0x${hex}`);
}
