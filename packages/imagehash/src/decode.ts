/**
 * Image decoding with `@jsquash/*` (WASM, no canvas, runs in Workers).
 *
 * The WASM is injected rather than fetched: `@jsquash` would otherwise `fetch()` the
 * `.wasm` next to its JS, which works in neither workerd nor Node. Each runtime compiles
 * the modules its own way and passes them in:
 *
 * - **Worker (wrangler):** import the files; wrangler bundles `.wasm` imports as
 *   `WebAssembly.Module`s.
 *   ```ts
 *   import jpeg from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
 *   import png from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
 *   import webp from "@jsquash/webp/codec/dec/webp_dec.wasm";
 *   const decode = createJsquashDecoder({ jpeg, png, webp });
 *   ```
 * - **Vitest (Node):** `nodeDecoder()` in `./testing/node-codecs.ts` reads and compiles them.
 *
 * Anything else (tests of the pure pipeline, a future Images binding) can supply its own
 * `Decoder`.
 */
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js";
import type { RgbaImage } from "./grid.ts";
import { initWithModule } from "./jsquash.ts";

export type ImageFormat = "jpeg" | "png" | "webp";

/** Turns encoded bytes into RGBA pixels. */
export type Decoder = (bytes: Uint8Array) => Promise<RgbaImage>;

/** Compiled `@jsquash` decoder modules, one per format. */
export interface JsquashWasm {
	readonly jpeg: WebAssembly.Module;
	readonly png: WebAssembly.Module;
	readonly webp: WebAssembly.Module;
}

export class UnsupportedImageError extends Error {
	override readonly name = "UnsupportedImageError";
}

/** Detects the format from magic bytes (never from a file name or MIME type). */
export function sniffFormat(bytes: Uint8Array): ImageFormat | undefined {
	const at = (i: number) => bytes[i];
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";
	if (
		at(0) === 0x89 &&
		at(1) === 0x50 &&
		at(2) === 0x4e &&
		at(3) === 0x47 &&
		at(4) === 0x0d &&
		at(5) === 0x0a &&
		at(6) === 0x1a &&
		at(7) === 0x0a
	) {
		return "png";
	}
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
	if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
	return undefined;
}

/**
 * Largest image decoded, in pixels. Clients upload at most ~2000 px on the long side
 * (TECH_STACK S15); RGBA costs 4 bytes per pixel in the WASM heap and again in JS, and a
 * Worker has 128 MB, so a larger header is refused before any pixel is allocated.
 */
export const MAX_DECODE_PIXELS = 2560 * 2560;

/**
 * Reads width and height from the file header without decoding (JPEG SOFn, PNG IHDR,
 * WebP VP8 / VP8L / VP8X). Returns undefined when the header can't be parsed.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	const format = sniffFormat(bytes);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16be = (i: number) => (i + 2 <= bytes.length ? view.getUint16(i) : undefined);
	if (format === "png") {
		if (bytes.length < 24) return undefined;
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (format === "jpeg") {
		let i = 2;
		while (i + 4 <= bytes.length) {
			if (bytes[i] !== 0xff) return undefined;
			const marker = bytes[i + 1]!;
			if (marker === 0xff) {
				i++;
				continue;
			}
			const length = u16be(i + 2);
			if (length === undefined) return undefined;
			// SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				const height = u16be(i + 5);
				const width = u16be(i + 7);
				return width === undefined || height === undefined ? undefined : { width, height };
			}
			i += 2 + length;
		}
		return undefined;
	}
	if (format === "webp") {
		if (bytes.length < 30) return undefined;
		const chunk = String.fromCharCode(...bytes.subarray(12, 16));
		const u24le = (i: number) => bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16);
		if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
		if (chunk === "VP8L") {
			const bits = view.getUint32(21, true);
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8 ")
			return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
	}
	return undefined;
}

/**
 * A decoder backed by `@jsquash`. Each codec is initialised once, on first use.
 * The codecs are module-level singletons, so every decoder in one isolate shares them.
 * Images whose header is unreadable or larger than `maxPixels` are refused.
 */
export function createJsquashDecoder(wasm: JsquashWasm, maxPixels = MAX_DECODE_PIXELS): Decoder {
	const ready = new Map<ImageFormat, Promise<unknown>>();
	const init = (format: ImageFormat): Promise<unknown> => {
		let p = ready.get(format);
		if (!p) {
			p = initWithModule({ jpeg: initJpeg, png: initPng, webp: initWebp }[format])(wasm[format]);
			ready.set(format, p);
		}
		return p;
	};
	return async (bytes) => {
		const format = sniffFormat(bytes);
		if (!format) throw new UnsupportedImageError("Not a JPEG, PNG or WebP image");
		const size = imageDimensions(bytes);
		if (!size) throw new UnsupportedImageError(`Unreadable ${format} header`);
		if (size.width * size.height > maxPixels) {
			throw new UnsupportedImageError(`Image too large: ${size.width}×${size.height}`);
		}
		await init(format);
		// The codecs take an ArrayBuffer; copy so a view into a larger buffer decodes correctly.
		const buffer = bytes.slice().buffer;
		const image =
			format === "jpeg"
				? await decodeJpeg(buffer)
				: format === "png"
					? await decodePng(buffer)
					: await decodeWebp(buffer);
		return { width: image.width, height: image.height, data: image.data };
	};
}
