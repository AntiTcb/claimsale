/**
 * Pixel grids: RGBA → grayscale, a deterministic area-average resampler, and the
 * dihedral transforms used for the hash variants. Pure TypeScript, no I/O, so it runs
 * the same in Node (Vitest) and in a Worker.
 */

/** Decoded image, the shape `ImageData` has (and what `@jsquash/*` decoders return). */
export interface RgbaImage {
	readonly width: number;
	readonly height: number;
	/** Row-major RGBA, 4 bytes per pixel. */
	readonly data: Uint8Array | Uint8ClampedArray;
}

/** Row-major single-channel image with float luma in 0..255. */
export interface GrayGrid {
	readonly width: number;
	readonly height: number;
	readonly data: Float64Array;
}

/**
 * Side of the square working grid every image is reduced to before the variants are
 * taken. Square, so the 90° rotations keep its shape; large enough that the 32×32 pHash
 * and 9×8 dHash grids are a further average of it.
 */
export const WORK_SIZE = 64;

/** Rec. 601 luma weights (the usual choice for perceptual hashes). */
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

function assertDimensions(width: number, height: number, length: number, channels: number): void {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new RangeError(`Invalid image size ${width}×${height}`);
	}
	if (length < width * height * channels) {
		throw new RangeError(`Pixel buffer too short for ${width}×${height}`);
	}
}

/**
 * Coverage weights for resampling `from` samples into `to` samples by area averaging:
 * output cell `o` covers input range [o·from/to, (o+1)·from/to). Works for shrinking and
 * enlarging. Returns, per output cell, the first input index and the weights (summing to 1).
 */
function areaWeights(from: number, to: number): { start: Int32Array; weights: Float64Array[] } {
	const scale = from / to;
	const start = new Int32Array(to);
	const weights: Float64Array[] = [];
	for (let o = 0; o < to; o++) {
		const lo = o * scale;
		const hi = (o + 1) * scale;
		const first = Math.floor(lo);
		const last = Math.min(from - 1, Math.ceil(hi) - 1);
		const w = new Float64Array(last - first + 1);
		for (let i = first; i <= last; i++) {
			w[i - first] = (Math.min(hi, i + 1) - Math.max(lo, i)) / scale;
		}
		start[o] = first;
		weights.push(w);
	}
	return { start, weights };
}

/**
 * Converts RGBA to luma and area-averages it to `outW`×`outH` in one separable pass
 * (rows first, then columns). Alpha is ignored: uploads are photos.
 */
export function rgbaToGray(image: RgbaImage, outW: number, outH: number): GrayGrid {
	const { width, height, data } = image;
	assertDimensions(width, height, data.length, 4);
	const h = areaWeights(width, outW);
	// Horizontal pass, fused with the luma conversion: height × outW.
	const rows = new Float64Array(height * outW);
	const luma = new Float64Array(width);
	for (let y = 0; y < height; y++) {
		const base = y * width * 4;
		for (let x = 0; x < width; x++) {
			const p = base + x * 4;
			luma[x] = LUMA_R * data[p]! + LUMA_G * data[p + 1]! + LUMA_B * data[p + 2]!;
		}
		for (let o = 0; o < outW; o++) {
			const s = h.start[o]!;
			const w = h.weights[o]!;
			let sum = 0;
			for (let i = 0; i < w.length; i++) sum += w[i]! * luma[s + i]!;
			rows[y * outW + o] = sum;
		}
	}
	return resampleColumns({ width: outW, height, data: rows }, outH);
}

function resampleColumns(grid: GrayGrid, outH: number): GrayGrid {
	const { width, height, data } = grid;
	const v = areaWeights(height, outH);
	const out = new Float64Array(width * outH);
	for (let o = 0; o < outH; o++) {
		const s = v.start[o]!;
		const w = v.weights[o]!;
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let i = 0; i < w.length; i++) sum += w[i]! * data[(s + i) * width + x]!;
			out[o * width + x] = sum;
		}
	}
	return { width, height: outH, data: out };
}

/** Area-average resample of a gray grid. */
export function resampleGray(grid: GrayGrid, outW: number, outH: number): GrayGrid {
	assertDimensions(grid.width, grid.height, grid.data.length, 1);
	const h = areaWeights(grid.width, outW);
	const rows = new Float64Array(grid.height * outW);
	for (let y = 0; y < grid.height; y++) {
		for (let o = 0; o < outW; o++) {
			const s = h.start[o]!;
			const w = h.weights[o]!;
			let sum = 0;
			for (let i = 0; i < w.length; i++) sum += w[i]! * grid.data[y * grid.width + s + i]!;
			rows[y * outW + o] = sum;
		}
	}
	return resampleColumns({ width: outW, height: grid.height, data: rows }, outH);
}

/** The five variants hashed for every image (PLAN "Photo authenticity", step 2). */
export const VARIANTS = ["orig", "mirror", "r90", "r180", "r270"] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * Applies a variant to a grid: `mirror` flips left↔right, `rN` rotates N° clockwise.
 * Area averaging commutes with these, so transforming the 64×64 working grid gives the
 * same grid as transforming the full-size photo first.
 */
export function transformGrid(grid: GrayGrid, variant: Variant): GrayGrid {
	const { width: w, height: h, data } = grid;
	if (variant === "orig") return grid;
	const rotatesAxes = variant === "r90" || variant === "r270";
	const outW = rotatesAxes ? h : w;
	const outH = rotatesAxes ? w : h;
	const out = new Float64Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let nx: number;
			let ny: number;
			switch (variant) {
				case "mirror":
					nx = w - 1 - x;
					ny = y;
					break;
				case "r90":
					nx = h - 1 - y;
					ny = x;
					break;
				case "r180":
					nx = w - 1 - x;
					ny = h - 1 - y;
					break;
				case "r270":
					nx = y;
					ny = w - 1 - x;
					break;
			}
			out[ny * outW + nx] = data[y * w + x]!;
		}
	}
	return { width: outW, height: outH, data: out };
}
