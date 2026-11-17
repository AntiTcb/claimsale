import { createDb, eq, type Db } from "@claimsale/db";
import { imageHashes, PHOTO_REASONS } from "@claimsale/db/photos";
import { itemImages, sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, GPS_MARKER, jpegBytes, memoryStore, webpBytes } from "../../../test/fixtures.ts";
import { MAX_BYTES, sanitizeImage, sniff } from "./image-sanitize.ts";
import {
	addItemPhoto,
	countCompletedSales,
	deleteItemPhoto,
	findImageWithSale,
	findTimestampPhoto,
	photosByItem,
	type PhotoView,
	publishPhotoState,
	rejectionMessage,
	setTimestampPhoto,
} from "./images.ts";
import { addItem } from "./items.ts";
import { createDraft } from "./sales.ts";

const contains = (haystack: Uint8Array, needle: string) =>
	new TextDecoder("latin1").decode(haystack).includes(needle);

describe("image sanitizing", () => {
	it("strips EXIF and comments from a JPEG and reads its size", () => {
		const input = jpegBytes(1600, 1200, { exif: true });
		expect(contains(input, GPS_MARKER)).toBe(true);
		const result = sanitizeImage(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({ type: "image/jpeg", width: 1600, height: 1200 });
		expect(contains(result.value.bytes, GPS_MARKER)).toBe(false);
		expect(contains(result.value.bytes, "comment")).toBe(false);
		expect(contains(result.value.bytes, "JFIF")).toBe(true);
		expect(result.value.bytes.at(-1)).toBe(0xd9);
	});

	it("strips the EXIF chunk from a WebP, clears its flag and fixes the RIFF size", () => {
		const input = webpBytes(2000, 1500, { exif: true });
		const result = sanitizeImage(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const out = result.value.bytes;
		expect(result.value).toMatchObject({ type: "image/webp", width: 2000, height: 1500 });
		expect(contains(out, GPS_MARKER)).toBe(false);
		expect(contains(out, "EXIF")).toBe(false);
		expect(out[20]! & 0x08).toBe(0);
		const riffSize = out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
		expect(riffSize).toBe(out.length - 8);
		expect(sanitizeImage(webpBytes(30, 20))).toMatchObject({ ok: true, value: { width: 30, height: 20 } });
	});

	it("rejects other formats, oversized images and broken files", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(sniff(png)).toBeNull();
		expect(sanitizeImage(png)).toEqual({ ok: false, error: "unsupported_type" });
		expect(sanitizeImage(jpegBytes(4000, 3000))).toEqual({ ok: false, error: "too_large" });
		expect(sanitizeImage(new Uint8Array(MAX_BYTES + 1))).toEqual({ ok: false, error: "too_large" });
		expect(sanitizeImage(jpegBytes(100, 100).subarray(0, 30))).toEqual({ ok: false, error: "corrupt" });
		const truncatedWebp = webpBytes(10, 10).subarray(0, 20);
		expect(sanitizeImage(truncatedWebp)).toEqual({ ok: false, error: "corrupt" });
	});
});

describe("item photos", () => {
	let db: Db;
	let saleId: string;
	let itemId: string;
	const store = memoryStore();
	const seller = { id: "seller", tier: "free" as const };

	beforeEach(async () => {
		db = createDb(testD1());
		store.objects.clear();
		await addUser(db, "seller");
		await addUser(db, "other");
		const sale = await createDraft(
			db,
			seller,
			{ title: "Sale", descriptionMd: "", visibility: "unlisted" },
			1,
		);
		if (!sale.ok) throw new Error("setup");
		saleId = sale.value.id;
		const item = await addItem(
			db,
			seller,
			saleId,
			{
				title: "Card",
				priceCents: 100,
				quantity: 1,
				gameId: "magic",
				kind: "single",
				condition: null,
				attributes: {},
			},
			1,
		);
		if (!item.ok) throw new Error("setup");
		itemId = item.value.id;
	});

	it("stores a sanitized photo in R2 with a pending row", async () => {
		const result = await addItemPhoto(
			db,
			store,
			seller,
			{ saleId, itemId },
			jpegBytes(800, 600, { exif: true }),
			5,
		);
		expect(result).toMatchObject({ ok: true, value: { status: "pending", width: 800, height: 600 } });
		const row = await db.select().from(itemImages).where(eq(itemImages.itemId, itemId)).get();
		expect(row).toMatchObject({
			status: "pending",
			sellerId: "seller",
			contentType: "image/jpeg",
			sortOrder: 0,
		});
		const stored = store.objects.get(row!.r2Key);
		expect(stored?.contentType).toBe("image/jpeg");
		expect(contains(stored!.body, GPS_MARKER)).toBe(false);
		expect(row!.r2Key).toBe(`sales/${saleId}/items/${itemId}/${row!.id}.jpg`);
		expect((await photosByItem(db, [itemId])).get(itemId)).toEqual([
			expect.objectContaining({ id: row!.id }),
		]);
		expect(await findImageWithSale(db, row!.id)).toMatchObject({
			sale: { id: saleId, sellerId: "seller", status: "draft", visibility: "unlisted" },
		});
	});

	it("[SM-2-photo-cap] refuses a fifth photo for a free seller and a thirteenth for Pro", async () => {
		for (let i = 0; i < 4; i++) {
			expect((await addItemPhoto(db, store, seller, { saleId, itemId }, webpBytes(10, 10), i)).ok).toBe(true);
		}
		const fifth = await addItemPhoto(db, store, seller, { saleId, itemId }, webpBytes(10, 10), 9);
		expect(fifth).toMatchObject({ ok: false, error: { code: "photo_cap_reached" } });
		const pro = { id: "seller", tier: "pro" as const };
		for (let i = 0; i < 8; i++) {
			expect((await addItemPhoto(db, store, pro, { saleId, itemId }, webpBytes(10, 10), i)).ok).toBe(true);
		}
		expect(await addItemPhoto(db, store, pro, { saleId, itemId }, webpBytes(10, 10), 20)).toMatchObject({
			error: { code: "photo_cap_reached" },
		});
		// Rejected photos don't count toward the cap.
		await db.update(itemImages).set({ status: "rejected" }).where(eq(itemImages.itemId, itemId));
		expect((await addItemPhoto(db, store, seller, { saleId, itemId }, webpBytes(10, 10), 30)).ok).toBe(true);
	});

	it("refuses another seller's item, a closed sale and a bad file; nothing is stored", async () => {
		const other = { id: "other", tier: "free" as const };
		expect(await addItemPhoto(db, store, other, { saleId, itemId }, jpegBytes(10, 10), 1)).toMatchObject({
			error: { code: "not_found" },
		});
		expect(
			await addItemPhoto(db, store, seller, { saleId, itemId }, new Uint8Array([1, 2, 3]), 1),
		).toMatchObject({
			error: { code: "unsupported_type" },
		});
		await db.update(sales).set({ status: "closed" }).where(eq(sales.id, saleId));
		expect(await addItemPhoto(db, store, seller, { saleId, itemId }, jpegBytes(10, 10), 1)).toMatchObject({
			error: { code: "invalid_status" },
		});
		expect(store.objects.size).toBe(0);
	});

	it("deletes a photo and its R2 object, only for its seller", async () => {
		const added = await addItemPhoto(db, store, seller, { saleId, itemId }, jpegBytes(10, 10), 1);
		if (!added.ok) throw new Error("setup");
		expect(await deleteItemPhoto(db, store, "other", saleId, added.value.id)).toMatchObject({
			error: { code: "not_found" },
		});
		expect(await deleteItemPhoto(db, store, "seller", saleId, added.value.id)).toEqual({
			ok: true,
			value: true,
		});
		expect(store.objects.size).toBe(0);
		expect(await findImageWithSale(db, added.value.id)).toBeUndefined();
		expect(await photosByItem(db, [])).toEqual(new Map());
	});

	const ids = async (view?: PhotoView) =>
		((await photosByItem(db, [itemId], view)).get(itemId) ?? []).map((p) => p.id);

	async function photoWith(
		status: "pending" | "approved" | "review" | "rejected",
		reason?: (typeof PHOTO_REASONS)[number],
	) {
		const added = await addItemPhoto(db, store, seller, { saleId, itemId }, jpegBytes(10, 10), 1);
		if (!added.ok) throw new Error("setup");
		await db.update(itemImages).set({ status }).where(eq(itemImages.id, added.value.id));
		if (reason) {
			await db.insert(imageHashes).values({
				imageId: added.value.id,
				sellerId: "seller",
				saleId,
				itemId,
				dhash: "0000000000000000",
				phash: "0000000000000000",
				d0: 0,
				d1: 0,
				d2: 0,
				d3: 0,
				p0: 0,
				p1: 0,
				p2: 0,
				p3: 0,
				decision: "rejected",
				reason,
				createdAt: 1,
				decidedAt: 1,
				decidedBy: "system",
			});
		}
		return added.value.id;
	}

	it("[IMG-public-approved] buyers get approved photos only; the seller's editor lists every photo", async () => {
		const approved = await photoWith("approved");
		const pending = await photoWith("pending");
		const held = await photoWith("review");
		const rejected = await photoWith("rejected", "duplicate");
		expect(await ids("approved")).toEqual([approved]);
		expect(await ids()).toEqual([approved, pending, held]);
		expect(await ids("all")).toEqual([approved, pending, held, rejected]);
	});

	it("[IMG-dup-reject] a rejected photo carries the seller's message, never the other seller", async () => {
		await photoWith("rejected", "duplicate");
		await photoWith("rejected", "own_reuse");
		await photoWith("rejected");
		const photos = (await photosByItem(db, [itemId], "all")).get(itemId) ?? [];
		expect(photos.map((p) => p.rejection)).toEqual([
			"This photo matches an image already used on ClaimSale. Please upload your own photo.",
			"You already used this photo for another item in this sale. Each item needs its own photo.",
			"This photo couldn't be read. Upload another one.",
		]);
		expect(rejectionMessage("timestamp_reuse")).toMatch(/already used/);
		expect(rejectionMessage("possible_duplicate")).toBe(rejectionMessage("duplicate"));
	});

	it("[IMG-timestamp-required] stores a timestamp photo, replacing the previous one", async () => {
		const first = await setTimestampPhoto(db, store, "seller", saleId, jpegBytes(10, 10), 2);
		if (!first.ok) throw new Error("setup");
		expect(await findTimestampPhoto(db, saleId)).toEqual({ id: first.value.id, status: "pending" });
		const second = await setTimestampPhoto(db, store, "seller", saleId, webpBytes(10, 10), 3);
		if (!second.ok) throw new Error("setup");
		expect(await findTimestampPhoto(db, saleId)).toEqual({ id: second.value.id, status: "pending" });
		expect(await findImageWithSale(db, first.value.id)).toBeUndefined();
		expect([...store.objects.keys()]).toEqual([`sales/${saleId}/timestamp/${second.value.id}.webp`]);
		// It's no item's photo, and doesn't count toward the item photo cap.
		expect((await photosByItem(db, [itemId], "all")).get(itemId)).toBeUndefined();
		expect(await setTimestampPhoto(db, store, "other", saleId, jpegBytes(10, 10), 4)).toMatchObject({
			error: { code: "not_found" },
		});
		expect(await setTimestampPhoto(db, store, "seller", saleId, new Uint8Array([1]), 4)).toMatchObject({
			error: { code: "unsupported_type" },
		});
	});

	it("[IMG-timestamp-required] counts closed and archived sales as completed, and gathers the publish state", async () => {
		expect(await countCompletedSales(db, "seller")).toBe(0);
		await db.update(sales).set({ status: "closed" }).where(eq(sales.id, saleId));
		expect(await countCompletedSales(db, "seller")).toBe(1);
		await db.update(sales).set({ status: "draft" }).where(eq(sales.id, saleId));
		await photoWith("approved");
		await photoWith("rejected");
		await setTimestampPhoto(db, store, "seller", saleId, jpegBytes(10, 10), 2);
		expect(await publishPhotoState(db, saleId, "seller")).toEqual({
			items: [{ photos: expect.arrayContaining(["approved", "rejected"]) }],
			timestamp: "pending",
			completedSales: 0,
		});
	});
});
