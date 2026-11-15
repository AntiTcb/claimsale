import {
	canAddPhoto,
	ok,
	reject,
	type Millis,
	type Rejection,
	type Result,
	type SaleStatus,
	type Tier,
} from "@claimsale/core";
import { and, asc, eq, inArray, ne, sql, type Db } from "@claimsale/db";
import { itemImages, items, sales } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";
import { sanitizeImage, type SanitizeError } from "./image-sanitize.ts";

/**
 * Item photos: R2 objects plus `item_images` rows (PLAN §5 "Images", D63). Every
 * upload starts `pending`; the photo-authenticity job (WS-F2) approves, holds or
 * rejects it. Objects are private: they're served only through the access-checked
 * route /api/images/[imageId] (SM-2-private-images).
 */

/** The R2 calls we use, so tests can pass an in-memory store. */
export type ImageStore = Pick<R2Bucket, "put" | "get" | "delete">;

export type ImageRow = typeof itemImages.$inferSelect;

export type ImageRejection = Rejection<"not_found" | "invalid_status" | "photo_cap_reached" | SanitizeError>;

const UPLOAD_STATUSES: ReadonlySet<SaleStatus> = new Set(["draft", "scheduled", "live"]);

const MESSAGES: Record<SanitizeError, string> = {
	unsupported_type: "Upload a JPEG or WebP photo",
	corrupt: "That file isn't a readable photo",
	too_large: "That photo is too large. Resize it to at most 2000 pixels and 5 MB.",
};

export interface PhotoSummary {
	readonly id: string;
	readonly itemId: string;
	readonly status: ImageRow["status"];
	readonly width: number | null;
	readonly height: number | null;
}

/** Photos per item, in order, without rejected ones. */
export async function photosByItem(db: Db, itemIds: readonly string[]): Promise<Map<string, PhotoSummary[]>> {
	const map = new Map<string, PhotoSummary[]>();
	if (itemIds.length === 0) return map;
	const rows = await db
		.select({
			id: itemImages.id,
			itemId: itemImages.itemId,
			status: itemImages.status,
			width: itemImages.width,
			height: itemImages.height,
		})
		.from(itemImages)
		.where(and(inArray(itemImages.itemId, [...itemIds]), ne(itemImages.status, "rejected")))
		.orderBy(asc(itemImages.sortOrder), asc(itemImages.id))
		.all();
	for (const row of rows) {
		if (!row.itemId) continue;
		const list = map.get(row.itemId) ?? [];
		list.push({ ...row, itemId: row.itemId });
		map.set(row.itemId, list);
	}
	return map;
}

/**
 * Stores a photo for an item: sanitize, check the cap, put into R2, record a `pending` row.
 *
 * @spec SM-2-photo-cap — counted per item, without rejected photos.
 */
export async function addItemPhoto(
	db: Db,
	store: ImageStore,
	seller: { id: string; tier: Tier },
	target: { saleId: string; itemId: string },
	upload: Uint8Array,
	now: Millis,
): Promise<Result<PhotoSummary, ImageRejection>> {
	const owned = await db
		.select({ status: sales.status })
		.from(items)
		.innerJoin(sales, eq(sales.id, items.saleId))
		.where(and(eq(items.id, target.itemId), eq(items.saleId, target.saleId), eq(sales.sellerId, seller.id)))
		.get();
	if (!owned) return reject("not_found", "No such item");
	if (!UPLOAD_STATUSES.has(owned.status))
		return reject("invalid_status", "Photos can't be added after the sale closes");
	const count = await db
		.select({ n: sql<number>`count(*)`, max: sql<number | null>`max(${itemImages.sortOrder})` })
		.from(itemImages)
		.where(and(eq(itemImages.itemId, target.itemId), ne(itemImages.status, "rejected")))
		.get();
	const allowed = canAddPhoto(seller.tier, count?.n ?? 0);
	if (!allowed.ok) return allowed;
	const clean = sanitizeImage(upload);
	if (!clean.ok) return reject(clean.error, MESSAGES[clean.error]);
	const id = uuidv7();
	const ext = clean.value.type === "image/webp" ? "webp" : "jpg";
	const r2Key = `sales/${target.saleId}/items/${target.itemId}/${id}.${ext}`;
	await store.put(r2Key, clean.value.bytes, { httpMetadata: { contentType: clean.value.type } });
	try {
		await db.insert(itemImages).values({
			id,
			saleId: target.saleId,
			itemId: target.itemId,
			sellerId: seller.id,
			r2Key,
			contentType: clean.value.type,
			bytes: clean.value.bytes.byteLength,
			width: clean.value.width,
			height: clean.value.height,
			sortOrder: (count?.max ?? -1) + 1,
			status: "pending",
			createdAt: now,
		});
	} catch (error) {
		await store.delete(r2Key);
		throw error;
	}
	return ok({
		id,
		itemId: target.itemId,
		status: "pending",
		width: clean.value.width,
		height: clean.value.height,
	});
}

export async function deleteItemPhoto(
	db: Db,
	store: ImageStore,
	sellerId: string,
	saleId: string,
	imageId: string,
): Promise<Result<true, ImageRejection>> {
	const row = await db
		.select({ r2Key: itemImages.r2Key })
		.from(itemImages)
		.where(and(eq(itemImages.id, imageId), eq(itemImages.saleId, saleId), eq(itemImages.sellerId, sellerId)))
		.get();
	if (!row) return reject("not_found", "No such photo");
	await db.delete(itemImages).where(eq(itemImages.id, imageId));
	await store.delete(row.r2Key);
	return ok(true);
}

export interface ImageWithSale {
	readonly r2Key: string;
	readonly contentType: string;
	readonly status: ImageRow["status"];
	readonly sale: {
		readonly id: string;
		readonly sellerId: string;
		readonly status: SaleStatus;
		readonly visibility: "public" | "unlisted" | "private";
	};
}

/** An image with the sale it belongs to, for the access check before serving it. */
export async function findImageWithSale(db: Db, imageId: string): Promise<ImageWithSale | undefined> {
	const row = await db
		.select({
			r2Key: itemImages.r2Key,
			contentType: itemImages.contentType,
			status: itemImages.status,
			saleId: sales.id,
			sellerId: sales.sellerId,
			saleStatus: sales.status,
			visibility: sales.visibility,
		})
		.from(itemImages)
		.innerJoin(sales, eq(sales.id, itemImages.saleId))
		.where(eq(itemImages.id, imageId))
		.get();
	if (!row) return undefined;
	return {
		r2Key: row.r2Key,
		contentType: row.contentType,
		status: row.status,
		sale: { id: row.saleId, sellerId: row.sellerId, status: row.saleStatus, visibility: row.visibility },
	};
}
