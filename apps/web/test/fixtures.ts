import type { Db } from "@claimsale/db";
import { subscriptions, users } from "@claimsale/db/schema";
import type { ImageStore } from "../src/lib/server/images.ts";

/** Builders shared by the web server tests (TESTING §8: factories, not fixtures). */

export async function addUser(
	db: Db,
	id: string,
	options: { handle?: string; email?: string; emailVerified?: boolean } = {},
): Promise<void> {
	const at = new Date("2026-11-01T00:00:00Z");
	await db.insert(users).values({
		id,
		email: options.email ?? `${id}@example.test`,
		emailVerified: options.emailVerified ?? true,
		displayName: `User ${id}`,
		handle: options.handle ?? id,
		createdAt: at,
		updatedAt: at,
	});
}

export async function grantSellerPro(db: Db, userId: string, now = 0): Promise<void> {
	await db.insert(subscriptions).values({
		userId,
		planId: "seller_pro",
		status: "granted",
		currentPeriodEnd: null,
		createdAt: now,
		updatedAt: now,
	});
}

/** An in-memory R2 stand-in with the calls the image code makes. */
export function memoryStore(): ImageStore & {
	objects: Map<string, { body: Uint8Array; contentType: string | undefined }>;
} {
	const objects = new Map<string, { body: Uint8Array; contentType: string | undefined }>();
	const store = {
		objects,
		put: async (key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) => {
			const body = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
			objects.set(key, { body, contentType: options?.httpMetadata?.contentType });
			return null;
		},
		get: async (key: string) => {
			const object = objects.get(key);
			if (!object) return null;
			return {
				body: new Blob([object.body as Uint8Array<ArrayBuffer>]).stream(),
				httpMetadata: { contentType: object.contentType },
			};
		},
		delete: async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
		},
	};
	return store as unknown as ImageStore & typeof store;
}

// ---------------------------------------------------------------------------
// Minimal image files: enough structure for sniffing, dimensions and metadata
// stripping (the server never decodes pixels).

const bytes = (...parts: Array<number[] | Uint8Array | string>) => {
	const arrays = parts.map((p) =>
		typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p),
	);
	const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
	let at = 0;
	for (const a of arrays) {
		out.set(a, at);
		at += a.length;
	}
	return out;
};
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

export const GPS_MARKER = "GPS-SECRET-47.6062N";

/** SOI, JFIF APP0, optional EXIF APP1 and COM, SOF0 with the size, SOS, data, EOI. */
export function jpegBytes(width: number, height: number, options: { exif?: boolean } = {}): Uint8Array {
	const app0 = bytes([0xff, 0xe0], be16(16), "JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0]);
	const exifPayload = bytes("Exif\0\0", GPS_MARKER);
	const app1 = bytes([0xff, 0xe1], be16(exifPayload.length + 2), exifPayload);
	const com = bytes([0xff, 0xfe], be16(2 + 7), "comment");
	const sof = bytes([0xff, 0xc0], be16(11), [8], be16(height), be16(width), [1, 1, 0x11, 0]);
	const sos = bytes([0xff, 0xda], be16(8), [1, 1, 0, 0, 0x3f, 0]);
	return bytes(
		[0xff, 0xd8],
		app0,
		options.exif ? app1 : [],
		options.exif ? com : [],
		sof,
		sos,
		[1, 2, 3, 4],
		[0xff, 0xd9],
	);
}

function chunk(fourcc: string, data: Uint8Array): Uint8Array {
	return bytes(fourcc, le32(data.length), data, data.length % 2 ? [0] : []);
}

/** RIFF/WEBP with a VP8X header (flags for EXIF when present), an EXIF chunk and a VP8L chunk. */
export function webpBytes(width: number, height: number, options: { exif?: boolean } = {}): Uint8Array {
	const flags = options.exif ? 0x08 : 0;
	const vp8x = chunk("VP8X", bytes([flags, 0, 0, 0], le24(width - 1), le24(height - 1)));
	const exif = chunk("EXIF", bytes(GPS_MARKER));
	const bits = (width - 1) | ((height - 1) << 14);
	const vp8l = chunk("VP8L", bytes([0x2f], le32(bits), [0, 0, 0]));
	const body = bytes("WEBP", vp8x, options.exif ? exif : [], vp8l);
	return bytes("RIFF", le32(body.length), body);
}
