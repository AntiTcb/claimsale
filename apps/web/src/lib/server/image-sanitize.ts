/**
 * Server-side checks on an uploaded photo (PLAN §5 "Images"). The browser already
 * resizes to at most 2000px and re-encodes on a canvas, which drops EXIF/GPS. This
 * is the fallback for anything that skips that step: it accepts only JPEG and WebP,
 * reads the real dimensions from the file, and removes metadata segments/chunks
 * (EXIF, XMP, comments) without decoding the image.
 */

export type ImageType = "image/jpeg" | "image/webp";

export interface SanitizedImage {
	readonly type: ImageType;
	readonly width: number;
	readonly height: number;
	readonly bytes: Uint8Array;
}

export type SanitizeError = "unsupported_type" | "corrupt" | "too_large";

/** Longest side allowed after the client resize (2000px plus a little slack for rounding). */
export const MAX_SIDE = 2048;
export const MAX_BYTES = 5 * 1024 * 1024;

export function sanitizeImage(
	input: Uint8Array,
): { ok: true; value: SanitizedImage } | { ok: false; error: SanitizeError } {
	if (input.byteLength > MAX_BYTES) return { ok: false, error: "too_large" };
	const type = sniff(input);
	if (!type) return { ok: false, error: "unsupported_type" };
	const result = type === "image/jpeg" ? stripJpeg(input) : stripWebp(input);
	if (!result) return { ok: false, error: "corrupt" };
	if (result.width > MAX_SIDE || result.height > MAX_SIDE) return { ok: false, error: "too_large" };
	return { ok: true, value: { type, ...result } };
}

export function sniff(b: Uint8Array): ImageType | null {
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
	return null;
}

function ascii(b: Uint8Array, at: number, length: number): string {
	return String.fromCharCode(...b.subarray(at, at + length));
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32le = (b: Uint8Array, at: number) =>
	(b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

interface Stripped {
	readonly width: number;
	readonly height: number;
	readonly bytes: Uint8Array;
}

/** JPEG: drops APP1–APP15 (EXIF, XMP, ICC…) and COM segments; keeps APP0 (JFIF) and image data. */
function stripJpeg(b: Uint8Array): Stripped | null {
	const out: Uint8Array[] = [b.subarray(0, 2)];
	let at = 2;
	let width = 0;
	let height = 0;
	while (at + 4 <= b.length) {
		if (b[at] !== 0xff) return null;
		const marker = b[at + 1]!;
		if (marker === 0xd9) break;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		const length = u16be(b, at + 2);
		if (length < 2 || at + 2 + length > b.length) return null;
		const segment = b.subarray(at, at + 2 + length);
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof && length >= 7) {
			height = u16be(b, at + 5);
			width = u16be(b, at + 7);
		}
		const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
		if (!isMetadata) out.push(segment);
		at += 2 + length;
		if (marker === 0xda) {
			// Start of scan: the rest is entropy-coded data up to EOI; keep it as is.
			out.push(b.subarray(at));
			at = b.length;
			break;
		}
	}
	if (width === 0 || height === 0) return null;
	return { width, height, bytes: concat(out) };
}

/** WebP: drops EXIF and XMP chunks and clears their VP8X flags. */
function stripWebp(b: Uint8Array): Stripped | null {
	const riffSize = u32le(b, 4);
	if (riffSize + 8 > b.length || riffSize < 4) return null;
	const chunks: Uint8Array[] = [];
	let at = 12;
	let width = 0;
	let height = 0;
	let vp8x: Uint8Array | null = null;
	while (at + 8 <= 8 + riffSize) {
		const fourcc = ascii(b, at, 4);
		const size = u32le(b, at + 4);
		const padded = size + (size & 1);
		if (at + 8 + size > b.length) return null;
		const chunk = b.slice(at, Math.min(at + 8 + padded, b.length));
		const data = at + 8;
		if (fourcc === "VP8X" && size >= 10) {
			width = u24le(b, data + 4) + 1;
			height = u24le(b, data + 7) + 1;
			vp8x = chunk;
		} else if (fourcc === "VP8 " && size >= 10 && width === 0) {
			width = u16le(b, data + 6) & 0x3fff;
			height = u16le(b, data + 8) & 0x3fff;
		} else if (fourcc === "VP8L" && size >= 5 && width === 0) {
			const bits = u32le(b, data + 1);
			width = (bits & 0x3fff) + 1;
			height = ((bits >>> 14) & 0x3fff) + 1;
		}
		if (fourcc !== "EXIF" && fourcc !== "XMP ") chunks.push(chunk);
		at += 8 + padded;
	}
	if (vp8x) vp8x[8] = vp8x[8]! & ~0x0c; // clear the EXIF (0x08) and XMP (0x04) flags
	if (width === 0 || height === 0) return null;
	const body = concat(chunks);
	const header = new Uint8Array(12);
	header.set(b.subarray(0, 12));
	const size = body.length + 4;
	header[4] = size & 0xff;
	header[5] = (size >>> 8) & 0xff;
	header[6] = (size >>> 16) & 0xff;
	header[7] = (size >>> 24) & 0xff;
	return { width, height, bytes: concat([header, body]) };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
