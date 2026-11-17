import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Decoder,
	imageDimensions,
	MAX_DECODE_PIXELS,
	sniffFormat,
	UnsupportedImageError,
} from "./decode.ts";
import { hammingDistance } from "./hash.ts";
import { hashImage } from "./image.ts";
import { encode, nodeDecoder } from "./testing/node-codecs.ts";
import { syntheticImage } from "./testing/synthetic.ts";

const fixture = async (name: string) =>
	new Uint8Array(await readFile(join(import.meta.dirname, "fixtures", name)));

let decode: Decoder;
beforeAll(async () => {
	decode = await nodeDecoder();
});

/** A PNG signature + IHDR claiming the given size (no pixel data). */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return bytes;
}

describe("sniffFormat and imageDimensions", () => {
	it("detects each format from magic bytes and reads the size from the header", async () => {
		for (const [name, format] of [
			["card-a.jpg", "jpeg"],
			["card-a.png", "png"],
			["card-a.webp", "webp"],
		] as const) {
			const bytes = await fixture(name);
			expect(sniffFormat(bytes)).toBe(format);
			expect(imageDimensions(bytes)).toEqual({ width: 240, height: 320 });
		}
	});

	it("reads lossless and extended WebP headers too", async () => {
		const img = syntheticImage(3, 37, 23);
		const lossless = await encode(img, "webp", 100, true);
		expect(imageDimensions(lossless)).toEqual({ width: 37, height: 23 });
		// VP8X: RIFF....WEBPVP8X, 4-byte chunk size, flags, 24-bit width-1 and height-1.
		const vp8x = new Uint8Array(30);
		vp8x.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"));
		vp8x.set([0x3f, 0x01, 0x00, 0xc7, 0x00, 0x00], 24);
		expect(imageDimensions(vp8x)).toEqual({ width: 320, height: 200 });
	});

	it("returns undefined for unknown or truncated data", () => {
		expect(sniffFormat(new TextEncoder().encode("GIF89a"))).toBeUndefined();
		expect(sniffFormat(new Uint8Array())).toBeUndefined();
		expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined();
		expect(imageDimensions(pngHeader(1, 1).subarray(0, 20))).toBeUndefined();
		expect(imageDimensions(new TextEncoder().encode("RIFF\0\0\0\0WEBP"))).toBeUndefined();
		// A JPEG whose segment chain is broken before any SOF marker.
		expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0x12]))).toBeUndefined();
	});
});

describe("createJsquashDecoder", () => {
	it("decodes JPEG, PNG and WebP to RGBA", async () => {
		for (const name of ["card-a.jpg", "card-a.png", "card-a.webp"]) {
			const img = await decode(await fixture(name));
			expect(img.width).toBe(240);
			expect(img.height).toBe(320);
			expect(img.data.length).toBe(240 * 320 * 4);
		}
	});

	it("gives the same photo the same hashes whatever the format", async () => {
		const [png, jpg, webp] = await Promise.all(
			["card-a.png", "card-a.jpg", "card-a.webp"].map(
				async (n) => hashImage(await decode(await fixture(n))).orig,
			),
		);
		for (const other of [jpg!, webp!]) {
			expect(hammingDistance(png!.dhash, other.dhash)).toBeLessThanOrEqual(3);
			expect(hammingDistance(png!.phash, other.phash)).toBeLessThanOrEqual(3);
		}
	});

	it("decodes a view into a larger buffer", async () => {
		const bytes = await fixture("card-a.png");
		const padded = new Uint8Array(bytes.length + 10);
		padded.set(bytes, 5);
		const img = await decode(padded.subarray(5, 5 + bytes.length));
		expect(img.width).toBe(240);
	});

	it("refuses unsupported formats, unreadable headers and oversized images before decoding", async () => {
		await expect(decode(new TextEncoder().encode("GIF89a........"))).rejects.toThrow(UnsupportedImageError);
		await expect(decode(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).rejects.toThrow(/Unreadable jpeg header/);
		const side = Math.ceil(Math.sqrt(MAX_DECODE_PIXELS)) + 1;
		await expect(decode(pngHeader(side, side))).rejects.toThrow(/too large/);
	});
});
