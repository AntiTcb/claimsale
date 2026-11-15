import { FREE_ITEM_CAP } from "@claimsale/core";
import { createDb, eq, type Db } from "@claimsale/db";
import { auditLog, entries, itemAttributes, sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, jpegBytes, memoryStore } from "../../../test/fixtures.ts";
import type { ItemFields } from "#lib/listing-input.ts";
import { addItemPhoto } from "./images.ts";
import { addItem, deleteItem, itemsWithoutPhotos, listItems, reorderItems, updateItem } from "./items.ts";
import { createDraft } from "./sales.ts";

let db: Db;
let saleId: string;
const free = { id: "seller", tier: "free" as const };
const pro = { id: "seller", tier: "pro" as const };
const card: ItemFields = {
	title: "Blue-Eyes White Dragon LOB-001",
	priceCents: 4000,
	quantity: 1,
	gameId: "yugioh",
	kind: "single",
	condition: "LP",
	attributes: { set: "LOB", edition: "1st", copies: 3 },
};

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	await addUser(db, "buyer");
	const sale = await createDraft(db, free, { title: "Sale", descriptionMd: "", visibility: "unlisted" }, 1);
	if (!sale.ok) throw new Error("setup");
	saleId = sale.value.id;
});

async function add(fields: Partial<ItemFields> = {}, seller = free) {
	const result = await addItem(db, seller, saleId, { ...card, ...fields }, 10);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

describe("items repository", () => {
	it("adds items at the end, mirroring filterable attributes", async () => {
		const a = await add();
		const b = await add({ title: "Dark Magician", attributes: {} });
		expect([a.sortOrder, b.sortOrder]).toEqual([0, 1]);
		expect(a).toMatchObject({
			priceCents: 4000,
			gameId: "yugioh",
			kind: "single",
			state: "available",
			version: 0,
		});
		const attrs = await db.select().from(itemAttributes).where(eq(itemAttributes.itemId, a.id)).all();
		expect(attrs).toEqual(
			expect.arrayContaining([
				{ itemId: a.id, key: "condition", valueText: "LP", valueNum: null },
				{ itemId: a.id, key: "set", valueText: "LOB", valueNum: null },
				{ itemId: a.id, key: "copies", valueText: null, valueNum: 3 },
			]),
		);
	});

	it("[SM-2-free-item-cap] stops a free seller at 10 items on add; Pro has no cap", async () => {
		for (let i = 0; i < FREE_ITEM_CAP; i++) await add({ title: `Card ${i}` });
		const refused = await addItem(db, free, saleId, card, 11);
		expect(refused).toMatchObject({ ok: false, error: { code: "item_cap_reached" } });
		expect((await addItem(db, pro, saleId, card, 11)).ok).toBe(true);
		expect(await listItems(db, saleId)).toHaveLength(FREE_ITEM_CAP + 1);
	});

	it("refuses items on someone else's sale or once the sale is live", async () => {
		expect(await addItem(db, { id: "buyer", tier: "free" }, saleId, card, 1)).toMatchObject({
			error: { code: "not_found" },
		});
		await db.update(sales).set({ status: "live" }).where(eq(sales.id, saleId));
		expect(await addItem(db, free, saleId, card, 1)).toMatchObject({ error: { code: "invalid_status" } });
	});

	it("[SM-2-lock-price-qty] locks price and quantity once the item has entries; the title stays editable and is logged", async () => {
		const item = await add();
		const repriced = await updateItem(
			db,
			"seller",
			saleId,
			item.id,
			{ ...card, priceCents: 3500, quantity: 2 },
			20,
		);
		expect(repriced).toMatchObject({ ok: true, value: { priceCents: 3500, quantity: 2, version: 1 } });

		await db.insert(entries).values({
			id: "e1",
			itemId: item.id,
			userId: "buyer",
			kind: "claim",
			amountCents: 3500,
			status: "won",
			createdAt: 30,
		});
		const price = await updateItem(
			db,
			"seller",
			saleId,
			item.id,
			{ ...card, priceCents: 3000, quantity: 2 },
			40,
		);
		expect(price).toMatchObject({ ok: false, error: { code: "price_qty_locked" } });
		const qty = await updateItem(
			db,
			"seller",
			saleId,
			item.id,
			{ ...card, priceCents: 3500, quantity: 1 },
			40,
		);
		expect(qty).toMatchObject({ ok: false, error: { code: "price_qty_locked" } });

		const retitled = await updateItem(
			db,
			"seller",
			saleId,
			item.id,
			{ ...card, title: "Blue-Eyes (LP, light edge wear)", priceCents: 3500, quantity: 2 },
			50,
		);
		expect(retitled).toMatchObject({
			ok: true,
			value: { title: "Blue-Eyes (LP, light edge wear)", version: 2 },
		});
		const audit = await db.select().from(auditLog).where(eq(auditLog.itemId, item.id)).all();
		expect(audit).toEqual([expect.objectContaining({ action: "item_edited", actorId: "seller", saleId })]);
		expect(await deleteItem(db, "seller", saleId, item.id)).toMatchObject({ error: { code: "has_entries" } });
	});

	it("reorders every item, and rejects a stale or partial order", async () => {
		const a = await add({ title: "A" });
		const b = await add({ title: "B" });
		const c = await add({ title: "C" });
		expect(await reorderItems(db, "seller", saleId, [c.id, a.id, b.id], 60)).toEqual({
			ok: true,
			value: true,
		});
		expect((await listItems(db, saleId)).map((i) => i.title)).toEqual(["C", "A", "B"]);
		expect(await reorderItems(db, "seller", saleId, [a.id, b.id], 61)).toMatchObject({
			error: { code: "invalid_order" },
		});
		expect(await reorderItems(db, "seller", saleId, [a.id, a.id, b.id], 61)).toMatchObject({
			error: { code: "invalid_order" },
		});
		expect(await reorderItems(db, "buyer", saleId, [a.id, b.id, c.id], 61)).toMatchObject({
			error: { code: "not_found" },
		});
	});

	it("deletes an item with its photos before the sale goes live, and tracks items without photos", async () => {
		const store = memoryStore();
		const a = await add({ title: "A" });
		const b = await add({ title: "B" });
		expect((await itemsWithoutPhotos(db, saleId)).toSorted()).toEqual([a.id, b.id].toSorted());
		const photo = await addItemPhoto(db, store, free, { saleId, itemId: a.id }, jpegBytes(800, 600), 70);
		expect(photo.ok).toBe(true);
		expect(await itemsWithoutPhotos(db, saleId)).toEqual([b.id]);
		const deleted = await deleteItem(db, "seller", saleId, a.id);
		expect(deleted.ok && deleted.value.r2Keys).toHaveLength(1);
		expect((await listItems(db, saleId)).map((i) => i.title)).toEqual(["B"]);
		expect(await deleteItem(db, "seller", saleId, a.id)).toMatchObject({ error: { code: "not_found" } });
		await db.update(sales).set({ status: "live" }).where(eq(sales.id, saleId));
		expect(await deleteItem(db, "seller", saleId, b.id)).toMatchObject({ error: { code: "invalid_status" } });
	});
});
