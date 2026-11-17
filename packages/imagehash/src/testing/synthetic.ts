/**
 * Test-only: seeded synthetic images and the edits a re-uploader might apply. The edits
 * work on full-size RGBA and are implemented independently of ../grid.ts (bilinear
 * resize, not area averaging), so the tests don't just check the pipeline against itself.
 */
import type { RgbaImage } from "../grid.ts";

export interface Rgba {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8ClampedArray;
}

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function blank(width: number, height: number): Uint8ClampedArray {
	return new Uint8ClampedArray(width * height * 4);
}

type Colour = readonly [number, number, number];

function randomColour(r: () => number): Colour {
	return [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
}

/**
 * A "scene": a gradient background, low-frequency texture, 4–9 filled rectangles and
 * ellipses, and mild per-pixel noise. Different seeds give unrelated images.
 */
export function syntheticImage(seed: number, width: number, height: number): Rgba {
	const r = rng(seed);
	const data = blank(width, height);
	const c0 = randomColour(r);
	const c1 = randomColour(r);
	const angle = r() * Math.PI * 2;
	const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
	const waves = Array.from({ length: 3 }, () => ({
		fx: (r() * 4 + 0.5) / width,
		fy: (r() * 4 + 0.5) / height,
		phase: r() * Math.PI * 2,
		amp: 6 + r() * 12,
	}));
	const shapes = Array.from({ length: 4 + Math.floor(r() * 6) }, () => ({
		ellipse: r() < 0.5,
		cx: r() * width,
		cy: r() * height,
		rx: (0.08 + r() * 0.3) * width,
		ry: (0.08 + r() * 0.3) * height,
		colour: randomColour(r),
	}));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const t = Math.min(1, Math.max(0, 0.5 + ((x / width - 0.5) * dx + (y / height - 0.5) * dy)));
			let px: [number, number, number] = [
				c0[0] + (c1[0] - c0[0]) * t,
				c0[1] + (c1[1] - c0[1]) * t,
				c0[2] + (c1[2] - c0[2]) * t,
			];
			for (const s of shapes) {
				const nx = (x - s.cx) / s.rx;
				const ny = (y - s.cy) / s.ry;
				const inside = s.ellipse ? nx * nx + ny * ny <= 1 : Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
				if (inside) px = [s.colour[0], s.colour[1], s.colour[2]];
			}
			let tex = 0;
			for (const w of waves) tex += w.amp * Math.sin(2 * Math.PI * (w.fx * x * 3 + w.fy * y * 3) + w.phase);
			const noise = (r() - 0.5) * 12;
			const p = (y * width + x) * 4;
			data[p] = px[0] + tex + noise;
			data[p + 1] = px[1] + tex + noise;
			data[p + 2] = px[2] + tex + noise;
			data[p + 3] = 255;
		}
	}
	return { width, height, data };
}

/**
 * A photo-like trading card on a playmat: textured mat, a slightly rotated card with a
 * border, an "art" window filled with a scene, and name/text bars. Same layout for
 * every seed, different art, which is the hard case for false positives.
 */
export function cardPhoto(seed: number, width = 480, height = 640): Rgba {
	const r = rng(seed ^ 0x9e3779b9);
	const art = syntheticImage(seed, 256, 192);
	const mat = randomColour(r);
	const frame = randomColour(r);
	const data = blank(width, height);
	const tilt = (r() - 0.5) * 0.08;
	const [cos, sin] = [Math.cos(tilt), Math.sin(tilt)];
	const [cx, cy] = [width / 2, height / 2];
	const [cw, ch] = [width * 0.72, height * 0.76];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// Card-local coordinates in 0..1 (rotated about the centre).
			const lx = ((x - cx) * cos + (y - cy) * sin) / cw + 0.5;
			const ly = (-(x - cx) * sin + (y - cy) * cos) / ch + 0.5;
			const matTex = 10 * Math.sin(x / 7 + y / 11) + (r() - 0.5) * 16;
			let px: Colour = [mat[0] + matTex, mat[1] + matTex, mat[2] + matTex];
			if (lx >= 0 && lx <= 1 && ly >= 0 && ly <= 1) {
				px = frame;
				const inArt = lx > 0.08 && lx < 0.92 && ly > 0.14 && ly < 0.55;
				const nameBar = lx > 0.08 && lx < 0.92 && ly > 0.05 && ly < 0.11;
				const textBox = lx > 0.08 && lx < 0.92 && ly > 0.6 && ly < 0.92;
				if (inArt) {
					const ax = Math.min(art.width - 1, Math.floor(((lx - 0.08) / 0.84) * art.width));
					const ay = Math.min(art.height - 1, Math.floor(((ly - 0.14) / 0.41) * art.height));
					const p = (ay * art.width + ax) * 4;
					px = [art.data[p]!, art.data[p + 1]!, art.data[p + 2]!];
				} else if (nameBar || textBox) {
					// Light box with dark "text" strokes.
					const line = Math.floor(ly * 90) % 3 === 0 && Math.sin(lx * 80 + seed) > -0.3;
					px = line ? [40, 40, 40] : [230, 225, 210];
				}
			}
			const p = (y * width + x) * 4;
			data[p] = px[0];
			data[p + 1] = px[1];
			data[p + 2] = px[2];
			data[p + 3] = 255;
		}
	}
	return { width, height, data };
}

function sample(img: RgbaImage, x: number, y: number, c: number): number {
	return img.data[(y * img.width + x) * 4 + c]!;
}

/** Bilinear resize (pixel-centre aligned). */
export function resizeBilinear(img: RgbaImage, width: number, height: number): Rgba {
	const data = blank(width, height);
	for (let y = 0; y < height; y++) {
		const sy = Math.min(img.height - 1, Math.max(0, ((y + 0.5) * img.height) / height - 0.5));
		const y0 = Math.floor(sy);
		const y1 = Math.min(img.height - 1, y0 + 1);
		const fy = sy - y0;
		for (let x = 0; x < width; x++) {
			const sx = Math.min(img.width - 1, Math.max(0, ((x + 0.5) * img.width) / width - 0.5));
			const x0 = Math.floor(sx);
			const x1 = Math.min(img.width - 1, x0 + 1);
			const fx = sx - x0;
			for (let c = 0; c < 4; c++) {
				const top = sample(img, x0, y0, c) * (1 - fx) + sample(img, x1, y0, c) * fx;
				const bottom = sample(img, x0, y1, c) * (1 - fx) + sample(img, x1, y1, c) * fx;
				data[(y * width + x) * 4 + c] = top * (1 - fy) + bottom * fy;
			}
		}
	}
	return { width, height, data };
}

export type Edit = "mirror" | "r90" | "r180" | "r270";

/** Mirror (left↔right) or rotate clockwise, on the full-size image. */
export function applyEdit(img: RgbaImage, edit: Edit): Rgba {
	const { width: w, height: h } = img;
	const swap = edit === "r90" || edit === "r270";
	const outW = swap ? h : w;
	const data = blank(w, h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const [nx, ny] =
				edit === "mirror"
					? [w - 1 - x, y]
					: edit === "r90"
						? [h - 1 - y, x]
						: edit === "r180"
							? [w - 1 - x, h - 1 - y]
							: [y, w - 1 - x];
			const from = (y * w + x) * 4;
			data.set(img.data.subarray(from, from + 4), (ny * outW + nx) * 4);
		}
	}
	return { width: outW, height: swap ? w : h, data };
}

/** Brightness offset (added) and contrast factor (around mid-grey), clamped. */
export function adjust(img: RgbaImage, brightness: number, contrast: number): Rgba {
	const data = blank(img.width, img.height);
	for (let i = 0; i < img.data.length; i += 4) {
		for (let c = 0; c < 3; c++) data[i + c] = (img.data[i + c]! - 128) * contrast + 128 + brightness;
		data[i + 3] = 255;
	}
	return { width: img.width, height: img.height, data };
}
