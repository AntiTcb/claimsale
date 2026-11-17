/**
 * The hashing pipeline: decoded RGBA → 64×64 gray working grid → 5 variants → dHash +
 * pHash for each, and the distance between an upload and a stored image.
 */
import { type RgbaImage, rgbaToGray, transformGrid, type Variant, VARIANTS, WORK_SIZE } from "./grid.ts";
import { dHash, hammingDistance, pHash } from "./hash.ts";

export type HashKind = "dhash" | "phash";

export interface HashPair {
	readonly dhash: bigint;
	readonly phash: bigint;
}

/** Hashes of the original and its mirrored / rotated versions. */
export type ImageHashes = Readonly<Record<Variant, HashPair>>;

/** Closest distance on each hash between an upload and one stored image (0..64). */
export interface MatchDistance {
	readonly dhash: number;
	readonly phash: number;
}

/** Computes dHash and pHash for all 5 variants of a decoded image. */
export function hashImage(image: RgbaImage): ImageHashes {
	const grid = rgbaToGray(image, WORK_SIZE, WORK_SIZE);
	const pair = (variant: Variant): HashPair => {
		const g = transformGrid(grid, variant);
		return { dhash: dHash(g), phash: pHash(g) };
	};
	return {
		orig: pair("orig"),
		mirror: pair("mirror"),
		r90: pair("r90"),
		r180: pair("r180"),
		r270: pair("r270"),
	};
}

/**
 * Distance from an upload (all variants) to a stored image's original hashes: the
 * minimum over the variants, taken separately for each hash.
 */
export function matchDistance(upload: ImageHashes, stored: HashPair): MatchDistance {
	let dhash = 64;
	let phash = 64;
	for (const variant of VARIANTS) {
		dhash = Math.min(dhash, hammingDistance(upload[variant].dhash, stored.dhash));
		phash = Math.min(phash, hammingDistance(upload[variant].phash, stored.phash));
	}
	return { dhash, phash };
}
