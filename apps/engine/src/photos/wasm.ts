/**
 * The `@jsquash` decoders with their WASM imported by the Worker (wrangler bundles
 * `.wasm` imports as `WebAssembly.Module`s), so nothing is fetched at runtime (S33).
 */
import { createJsquashDecoder, type Decoder } from "@claimsale/imagehash/decode";
import jpeg from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?module";
import png from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm?module";
import webp from "@jsquash/webp/codec/dec/webp_dec.wasm?module";

let decoder: Decoder | undefined;

/** One decoder per isolate; each codec initialises on first use. */
export function workerDecoder(): Decoder {
	decoder ??= createJsquashDecoder({ jpeg, png, webp });
	return decoder;
}
