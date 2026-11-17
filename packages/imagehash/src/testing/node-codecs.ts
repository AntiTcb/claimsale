/**
 * Test-only: loads the `@jsquash` WASM from node_modules for Vitest (Node), and exposes
 * the encoders used to re-encode images in the robustness tests. Never imported by
 * runtime code; Workers import the `.wasm` files directly (see ../decode.ts).
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import encodeJpeg, { init as initJpegEnc } from "@jsquash/jpeg/encode.js";
import encodePng, { init as initPngEnc } from "@jsquash/png/encode.js";
import encodeWebp, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import { createJsquashDecoder, type Decoder } from "../decode.ts";
import type { RgbaImage } from "../grid.ts";
import { initWithModule } from "../jsquash.ts";

const require = createRequire(import.meta.url);

async function compile(specifier: string): Promise<WebAssembly.Module> {
	const bytes = await readFile(require.resolve(specifier));
	return WebAssembly.compile(bytes);
}

let decoder: Promise<Decoder> | undefined;

/** The production decoder, with WASM compiled from node_modules. */
export function nodeDecoder(): Promise<Decoder> {
	decoder ??= (async () => {
		const [jpeg, png, webp] = await Promise.all([
			compile("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"),
			compile("@jsquash/png/codec/pkg/squoosh_png_bg.wasm"),
			compile("@jsquash/webp/codec/dec/webp_dec.wasm"),
		]);
		return createJsquashDecoder({ jpeg, png, webp });
	})();
	return decoder;
}

let encoders: Promise<void> | undefined;

function initEncoders(): Promise<void> {
	encoders ??= (async () => {
		const [jpeg, png, webp] = await Promise.all([
			compile("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"),
			// One WASM module holds both the PNG encoder and decoder.
			compile("@jsquash/png/codec/pkg/squoosh_png_bg.wasm"),
			// Node has WASM SIMD, which is what @jsquash/webp picks at runtime.
			compile("@jsquash/webp/codec/enc/webp_enc_simd.wasm"),
		]);
		await initWithModule(initJpegEnc)(jpeg);
		await initWithModule(initPngEnc)(png);
		await initWithModule(initWebpEnc)(webp);
	})();
	return encoders;
}

/** The encoders read only width, height and data, which is what an RgbaImage has. */
function toImageData(image: RgbaImage) {
	const data = Uint8ClampedArray.from(image.data);
	return { width: image.width, height: image.height, data, colorSpace: "srgb" as const };
}

/** Encodes RGBA; `lossless` applies to WebP only. */
export async function encode(
	image: RgbaImage,
	format: "jpeg" | "png" | "webp",
	quality = 85,
	lossless = false,
): Promise<Uint8Array> {
	await initEncoders();
	const imageData = toImageData(image);
	const buffer =
		format === "jpeg"
			? await encodeJpeg(imageData, { quality })
			: format === "webp"
				? await encodeWebp(imageData, { quality, lossless: lossless ? 1 : 0 })
				: await encodePng(imageData);
	return new Uint8Array(buffer);
}
