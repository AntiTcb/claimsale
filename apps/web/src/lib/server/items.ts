import {
	canAddItem,
	editableItemFields,
	ok,
	reject,
	type Millis,
	type Rejection,
	type Result,
	type SaleStatus,
	type Tier,
} from "@claimsale/core";
import { and, asc, eq, inList, sql, type Db } from "@claimsale/db";
import { auditLog, entries, itemAttributes, itemImages, items, sales } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";
import type { ItemFields } from "#lib/listing-input.ts";

/** Items repository: the seller's table editor and the read-only sale views. */

export type ItemRow = typeof items.$inferSelect;

export type ItemRejection = Rejection<
	"not_found" | "invalid_status" | "item_cap_reached" | "price_qty_locked" | "has_entries" | "invalid_order"
>;

const notFound = () => reject("not_found", "No such item");

/** Statuses in which items can be added, reordered or deleted (draft and scheduled, STATE_MACHINES §2). */
const BEFORE_LIVE: ReadonlySet<SaleStatus> = new Set(["draft", "scheduled"]);
/** Statuses in which existing items can still be edited (within SM-2-lock-price-qty). */
const EDITABLE: ReadonlySet<SaleStatus> = new Set(["draft", "scheduled", "live"]);

interface OwnedSale {
	readonly id: string;
	readonly status: SaleStatus;
}

async function ownedSale(db: Db, sellerId: string, saleId: string): Promise<OwnedSale | undefined> {
	return db
		.select({ id: sales.id, status: sales.status })
		.from(sales)
		.where(and(eq(sales.id, saleId), eq(sales.sellerId, sellerId)))
		.get();
}

export async function countItems(db: Db, saleId: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(items)
		.where(eq(items.saleId, saleId))
		.get();
	return row?.n ?? 0;
}

export async function listItems(db: Db, saleId: string): Promise<ItemRow[]> {
	return db
		.select()
		.from(items)
		.where(eq(items.saleId, saleId))
		.orderBy(asc(items.sortOrder), asc(items.id))
		.all();
}

export async function findItem(db: Db, saleId: string, itemId: string): Promise<ItemRow | undefined> {
	return db
		.select()
		.from(items)
		.where(and(eq(items.id, itemId), eq(items.saleId, saleId)))
		.get();
}

/** Claims and offers ever placed on the item (any status): what locks price and quantity (D40). */
export async function entryCount(db: Db, itemId: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(entries)
		.where(eq(entries.itemId, itemId))
		.get();
	return row?.n ?? 0;
}

/** Which of these items have any entries, i.e. have price and quantity locked (D40). */
export async function itemsWithEntries(db: Db, itemIds: readonly string[]): Promise<Set<string>> {
	if (itemIds.length === 0) return new Set();
	const rows = await db
		.selectDistinct({ itemId: entries.itemId })
		.from(entries)
		.where(inList(entries.itemId, [...itemIds]))
		.all();
	return new Set(rows.map((r) => r.itemId));
}

/** Filterable attributes mirrored into item_attributes (browse filters, PLAN §3). */
function attributeRows(itemId: string, fields: ItemFields) {
	const rows: Array<typeof itemAttributes.$inferInsert> = [];
	if (fields.condition) rows.push({ itemId, key: "condition", valueText: fields.condition });
	for (const [key, value] of Object.entries(fields.attributes)) {
		// One row per key: the condition column wins over an attribute of the same name.
		if (key === "condition" && fields.condition) continue;
		if (typeof value === "number" && Number.isSafeInteger(value)) rows.push({ itemId, key, valueNum: value });
		else rows.push({ itemId, key, valueText: String(value) });
	}
	return rows;
}

/**
 * Adds an item at the end of the sale.
 *
 * @spec SM-2-free-item-cap — checked on add, here, and again on publish.
 */
export async function addItem(
	db: Db,
	seller: { id: string; tier: Tier },
	saleId: string,
	fields: ItemFields,
	now: Millis,
): Promise<Result<ItemRow, ItemRejection | Rejection<"no_items" | "sale_cap_reached">>> {
	const sale = await ownedSale(db, seller.id, saleId);
	if (!sale) return reject("not_found", "No such sale");
	const itemCount = await countItems(db, saleId);
	const allowed = canAddItem({
		status: sale.status,
		liveAt: null,
		closesAt: null,
		sellerTier: seller.tier,
		itemCount,
	});
	if (!allowed.ok) {
		return reject(
			allowed.error.code === "item_cap_reached" ? "item_cap_reached" : "invalid_status",
			allowed.error.message,
		);
	}
	const id = uuidv7();
	const last = await db
		.select({ max: sql<number | null>`max(${items.sortOrder})` })
		.from(items)
		.where(eq(items.saleId, saleId))
		.get();
	const sortOrder = (last?.max ?? -1) + 1;
	const insert = db
		.insert(items)
		.values({
			id,
			saleId,
			sortOrder,
			title: fields.title,
			priceCents: fields.priceCents,
			quantity: fields.quantity,
			gameId: fields.gameId,
			kind: fields.kind,
			condition: fields.condition,
			attributes: fields.attributes,
			catalogProductId: fields.catalogProductId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	const attrs = attributeRows(id, fields);
	const [rows] = await db.batch([insert, ...attrs.map((row) => db.insert(itemAttributes).values(row))]);
	await db.update(sales).set({ updatedAt: now }).where(eq(sales.id, saleId));
	return ok(rows[0]!);
}

/**
 * Edits an item. Title, attributes and photos stay editable once it has entries;
 * price and quantity don't (D40). Edits after entries are audit-logged.
 *
 * @spec SM-2-lock-price-qty
 */
export async function updateItem(
	db: Db,
	sellerId: string,
	saleId: string,
	itemId: string,
	fields: ItemFields,
	now: Millis,
): Promise<Result<ItemRow, ItemRejection>> {
	const sale = await ownedSale(db, sellerId, saleId);
	if (!sale) return reject("not_found", "No such sale");
	if (!EDITABLE.has(sale.status))
		return reject("invalid_status", "Items can't be edited after the sale closes");
	const item = await findItem(db, saleId, itemId);
	if (!item) return notFound();
	const count = await entryCount(db, itemId);
	const editable = editableItemFields(count);
	if (
		(!editable.has("price") && fields.priceCents !== item.priceCents) ||
		(!editable.has("quantity") && fields.quantity !== item.quantity)
	) {
		return reject("price_qty_locked", "Price and quantity are locked once an item has claims or offers");
	}
	const update = db
		.update(items)
		.set({
			title: fields.title,
			priceCents: fields.priceCents,
			quantity: fields.quantity,
			gameId: fields.gameId,
			kind: fields.kind,
			condition: fields.condition,
			attributes: fields.attributes,
			...(fields.catalogProductId === undefined ? {} : { catalogProductId: fields.catalogProductId }),
			version: sql`${items.version} + 1`,
			updatedAt: now,
		})
		.where(eq(items.id, itemId))
		.returning();
	const attrs = attributeRows(itemId, fields);
	const audit =
		count > 0
			? [
					db.insert(auditLog).values({
						id: uuidv7(),
						saleId,
						itemId,
						actorId: sellerId,
						action: "item_edited",
						data: { title: fields.title, from: item.title },
						createdAt: now,
					}),
				]
			: [];
	const [rows] = await db.batch([
		update,
		db.delete(itemAttributes).where(eq(itemAttributes.itemId, itemId)),
		...attrs.map((row) => db.insert(itemAttributes).values(row)),
		...audit,
	]);
	return ok(rows[0]!);
}

/**
 * Sets several items' prices at once: the bulk "N % of market" apply (D64), with the
 * prices from the preview the seller confirmed. Items with entries keep their price.
 *
 * @spec SM-2-lock-price-qty
 */
export async function setPrices(
	db: Db,
	sellerId: string,
	saleId: string,
	changes: readonly { readonly itemId: string; readonly priceCents: number }[],
	now: Millis,
): Promise<Result<{ updated: number }, ItemRejection>> {
	const sale = await ownedSale(db, sellerId, saleId);
	if (!sale) return reject("not_found", "No such sale");
	if (!EDITABLE.has(sale.status))
		return reject("invalid_status", "Items can't be edited after the sale closes");
	const ids = [...new Set(changes.map((c) => c.itemId))];
	if (ids.length === 0) return ok({ updated: 0 });
	const own = await db
		.select({ id: items.id })
		.from(items)
		.where(and(eq(items.saleId, saleId), inList(items.id, ids)))
		.all();
	if (own.length !== ids.length) return notFound();
	if ((await itemsWithEntries(db, ids)).size > 0) {
		return reject("price_qty_locked", "Price and quantity are locked once an item has claims or offers");
	}
	const [first, ...rest] = changes.map((c) =>
		db
			.update(items)
			.set({ priceCents: c.priceCents, version: sql`${items.version} + 1`, updatedAt: now })
			.where(and(eq(items.id, c.itemId), eq(items.saleId, saleId))),
	);
	if (first) await db.batch([first, ...rest]);
	return ok({ updated: changes.length });
}

/** Puts the sale's items in the given order. Every item must be listed exactly once. */
export async function reorderItems(
	db: Db,
	sellerId: string,
	saleId: string,
	orderedIds: readonly string[],
	now: Millis,
): Promise<Result<true, ItemRejection>> {
	const sale = await ownedSale(db, sellerId, saleId);
	if (!sale) return reject("not_found", "No such sale");
	if (!EDITABLE.has(sale.status))
		return reject("invalid_status", "Items can't be reordered after the sale closes");
	const current = await db.select({ id: items.id }).from(items).where(eq(items.saleId, saleId)).all();
	const known = new Set(current.map((r) => r.id));
	if (
		orderedIds.length !== known.size ||
		new Set(orderedIds).size !== known.size ||
		!orderedIds.every((id) => known.has(id))
	) {
		return reject("invalid_order", "The list of items changed. Reload and try again.");
	}
	const [first, ...rest] = orderedIds.map((id, index) =>
		db.update(items).set({ sortOrder: index, updatedAt: now }).where(eq(items.id, id)),
	);
	if (first) await db.batch([first, ...rest]);
	return ok(true);
}

/** Deletes an item that has never had entries, before the sale goes live. */
export async function deleteItem(
	db: Db,
	sellerId: string,
	saleId: string,
	itemId: string,
): Promise<Result<{ r2Keys: string[] }, ItemRejection>> {
	const sale = await ownedSale(db, sellerId, saleId);
	if (!sale) return reject("not_found", "No such sale");
	if (!BEFORE_LIVE.has(sale.status))
		return reject("invalid_status", "Items can only be deleted before the sale goes live");
	const item = await findItem(db, saleId, itemId);
	if (!item) return notFound();
	if ((await entryCount(db, itemId)) > 0) return reject("has_entries", "This item has claims or offers");
	const images = await db
		.select({ key: itemImages.r2Key })
		.from(itemImages)
		.where(eq(itemImages.itemId, itemId))
		.all();
	await db.delete(items).where(eq(items.id, itemId));
	return ok({ r2Keys: images.map((i) => i.key) });
}

/** Items of the sale that have no photo yet (D63: every item needs one before publishing). */
export async function itemsWithoutPhotos(db: Db, saleId: string): Promise<string[]> {
	const rows = await db
		.select({ id: items.id })
		.from(items)
		.where(
			and(
				eq(items.saleId, saleId),
				sql`NOT EXISTS (SELECT 1 FROM item_images WHERE item_images.item_id = ${items.id} AND item_images.status != 'rejected')`,
			),
		)
		.all();
	return rows.map((r) => r.id);
}
