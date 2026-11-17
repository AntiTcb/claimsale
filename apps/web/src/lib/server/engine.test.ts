import { DAY, HOUR } from "@claimsale/core";
import { and, createDb, eq, isNotNull, type Db } from "@claimsale/db";
import { auditLog, itemImages, sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, grantSellerPro, jpegBytes, memoryStore } from "../../../test/fixtures.ts";
import { localEngine, type Engine } from "./engine.ts";
import { addItemPhoto, setTimestampPhoto } from "./images.ts";
import { addItem } from "./items.ts";
import { createDraft } from "./sales.ts";

let db: Db;
let engine: Engine;
const now = Date.UTC(2026, 10, 15, 12);
const store = memoryStore();

beforeEach(async () => {
	db = createDb(testD1());
	engine = localEngine(db);
	await addUser(db, "seller");
	await addUser(db, "other");
});

/** Sets the status the photo verify job (engine) would have decided. */
const decidePhotos = (saleId: string, status: "approved" | "review" | "rejected" | "pending") =>
	db.update(itemImages).set({ status }).where(eq(itemImages.saleId, saleId));

/**
 * A draft with `count` items, each with a photo unless `photos` is false, plus a
 * timestamp photo unless `timestamp` is false; all photos approved unless `photoStatus`
 * says otherwise.
 */
async function draftWithItems(
	count = 1,
	options: {
		photos?: boolean;
		sellerId?: string;
		timestamp?: boolean;
		photoStatus?: "approved" | "review" | "rejected" | "pending";
	} = {},
) {
	const seller = { id: options.sellerId ?? "seller", tier: "pro" as const };
	const sale = await createDraft(
		db,
		seller,
		{ title: "Sale", descriptionMd: "", visibility: "unlisted" },
		now,
	);
	if (!sale.ok) throw new Error("setup");
	for (let i = 0; i < count; i++) {
		const item = await addItem(
			db,
			seller,
			sale.value.id,
			{
				title: `Card ${i}`,
				priceCents: 500,
				quantity: 1,
				gameId: "pokemon",
				kind: "single",
				condition: "NM",
				attributes: {},
			},
			now,
		);
		if (!item.ok) throw new Error("setup");
		if (options.photos !== false) {
			await addItemPhoto(
				db,
				store,
				seller,
				{ saleId: sale.value.id, itemId: item.value.id },
				jpegBytes(10, 10),
				now,
			);
		}
	}
	if (options.timestamp !== false) {
		await setTimestampPhoto(db, store, seller.id, sale.value.id, jpegBytes(10, 10), now);
	}
	await decidePhotos(sale.value.id, options.photoStatus ?? "approved");
	return sale.value.id;
}

/** Publishes now, as the seller. */
const publish = (saleId: string) =>
	engine.publish({ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY }, now);

const statusOf = async (saleId: string) =>
	(await db.select({ status: sales.status }).from(sales).where(eq(sales.id, saleId)).get())?.status;

describe("local engine: publish and schedule", () => {
	it("[SM-2-publish-scheduled] a future go-live time schedules the sale and writes an audit row", async () => {
		const saleId = await draftWithItems();
		const result = await engine.publish(
			{ saleId, sellerId: "seller", liveAt: now + DAY, closesAt: now + 3 * DAY },
			now,
		);
		expect(result).toEqual({
			ok: true,
			value: { status: "scheduled", liveAt: now + DAY, closesAt: now + 3 * DAY },
		});
		const row = await db.select().from(sales).where(eq(sales.id, saleId)).get();
		expect(row).toMatchObject({ status: "scheduled", liveAt: now + DAY, publishedAt: now });
		const audit = await db.select().from(auditLog).where(eq(auditLog.saleId, saleId)).all();
		expect(audit).toEqual([
			expect.objectContaining({
				action: "sale_published",
				actorId: "seller",
				data: expect.objectContaining({ status: "scheduled" }),
			}),
		]);
	});

	it("[SM-2-publish-now] no go-live time makes the sale live now", async () => {
		const saleId = await draftWithItems();
		const result = await engine.publish(
			{ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY },
			now,
		);
		expect(result).toEqual({ ok: true, value: { status: "live", liveAt: now, closesAt: now + DAY } });
		expect(await statusOf(saleId)).toBe("live");
	});

	it("[SM-2-preview-window] refuses a go-live time more than 7 days ahead", async () => {
		const saleId = await draftWithItems();
		const liveAt = now + 7 * DAY + HOUR;
		const result = await engine.publish({ saleId, sellerId: "seller", liveAt, closesAt: liveAt + DAY }, now);
		expect(result).toMatchObject({ ok: false, error: { code: "preview_too_early" } });
		expect(await statusOf(saleId)).toBe("draft");
		const ok = await engine.publish(
			{ saleId, sellerId: "seller", liveAt: now + 7 * DAY, closesAt: now + 8 * DAY },
			now,
		);
		expect(ok.ok).toBe(true);
	});

	it("[SM-2-free-sale-cap] a free seller can't publish a third sale; Pro can", async () => {
		const ids = [await draftWithItems(), await draftWithItems(), await draftWithItems()];
		for (const saleId of ids.slice(0, 2)) {
			expect(
				(await engine.publish({ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY }, now)).ok,
			).toBe(true);
		}
		const third = await engine.publish(
			{ saleId: ids[2]!, sellerId: "seller", liveAt: null, closesAt: now + DAY },
			now,
		);
		expect(third).toMatchObject({ ok: false, error: { code: "sale_cap_reached" } });
		await grantSellerPro(db, "seller", now);
		expect(
			(await engine.publish({ saleId: ids[2]!, sellerId: "seller", liveAt: null, closesAt: now + DAY }, now))
				.ok,
		).toBe(true);
	});

	it("[SM-2-free-item-cap] re-checks the item cap on publish (e.g. after a Pro downgrade)", async () => {
		const saleId = await draftWithItems(11);
		const result = await engine.publish(
			{ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY },
			now,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "item_cap_reached" } });
	});

	it("refuses an empty sale, an item without a photo, and someone else's sale", async () => {
		const empty = await draftWithItems(0);
		expect(
			await engine.publish({ saleId: empty, sellerId: "seller", liveAt: null, closesAt: now + DAY }, now),
		).toMatchObject({
			error: { code: "no_items" },
		});
		const noPhoto = await draftWithItems(1, { photos: false });
		expect(
			await engine.publish({ saleId: noPhoto, sellerId: "seller", liveAt: null, closesAt: now + DAY }, now),
		).toMatchObject({ error: { code: "missing_photos" } });
		const mine = await draftWithItems();
		expect(
			await engine.publish({ saleId: mine, sellerId: "other", liveAt: null, closesAt: now + DAY }, now),
		).toMatchObject({
			error: { code: "not_found" },
		});
	});

	it("[IMG-required] photos still being checked, held or rejected block publishing", async () => {
		expect(await publish(await draftWithItems(1, { photoStatus: "pending" }))).toMatchObject({
			error: { code: "photos_pending" },
		});
		expect(await publish(await draftWithItems(1, { photoStatus: "rejected" }))).toMatchObject({
			error: { code: "missing_photos" },
		});
		const held = await draftWithItems(2);
		await db
			.update(itemImages)
			.set({ status: "review" })
			.where(and(eq(itemImages.saleId, held), isNotNull(itemImages.itemId)));
		expect(await publish(held)).toMatchObject({ error: { code: "photos_in_review" } });
		expect(await statusOf(held)).toBe("draft");
	});

	it("[IMG-timestamp-required] a seller with fewer than 5 completed sales needs an approved timestamp photo", async () => {
		const none = await draftWithItems(1, { timestamp: false });
		expect(await publish(none)).toMatchObject({ error: { code: "timestamp_required" } });

		// Five completed sales make it optional.
		for (let i = 0; i < 5; i++) {
			const done = await draftWithItems(0, { timestamp: false });
			await db
				.update(sales)
				.set({ status: i % 2 ? "closed" : "archived" })
				.where(eq(sales.id, done));
		}
		expect(await publish(none)).toMatchObject({ ok: true });
	});

	it("[IMG-timestamp-required] a replaced timestamp photo is the one that counts", async () => {
		const saleId = await draftWithItems(1);
		await setTimestampPhoto(db, store, "seller", saleId, jpegBytes(12, 12), now);
		const photos = await db.select().from(itemImages).where(eq(itemImages.saleId, saleId)).all();
		expect(photos.filter((p) => p.itemId === null)).toEqual([expect.objectContaining({ status: "pending" })]);
		expect(
			await engine.publish({ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY }, now),
		).toMatchObject({ error: { code: "timestamp_pending" } });
	});

	it("unpublishes a scheduled sale back to a draft, and refuses a second publish", async () => {
		const saleId = await draftWithItems();
		await engine.publish({ saleId, sellerId: "seller", liveAt: now + DAY, closesAt: now + 2 * DAY }, now);
		expect(
			await engine.publish({ saleId, sellerId: "seller", liveAt: now + DAY, closesAt: now + 2 * DAY }, now),
		).toMatchObject({
			error: { code: "invalid_status" },
		});
		expect(await engine.unpublish({ saleId, sellerId: "seller" }, now + 1)).toEqual({
			ok: true,
			value: { status: "draft", liveAt: null, closesAt: null },
		});
		expect(await engine.unpublish({ saleId, sellerId: "seller" }, now + 2)).toMatchObject({
			error: { code: "invalid_status" },
		});
		const actions = (await db.select().from(auditLog).where(eq(auditLog.saleId, saleId)).all()).map(
			(a) => a.action,
		);
		expect(actions).toEqual(["sale_published", "sale_unpublished"]);
	});
});
