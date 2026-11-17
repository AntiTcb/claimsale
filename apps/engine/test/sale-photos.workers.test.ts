/**
 * Photo checks in the SaleEngine's publish command (WS-F2): the engine reads the photo
 * state under the sale lock and refuses with core's checkPublishPhotos codes.
 */
import { describe, expect, it } from "vitest";
import {
	addPhoto,
	DAY,
	db,
	engine,
	HOUR,
	makeSale,
	rejection,
	saleRow,
	value,
	type SaleSetup,
} from "./sale-fixtures.ts";

const publishNow = (sale: SaleSetup) =>
	engine.publishSale({
		saleId: sale.saleId,
		sellerId: sale.sellerId,
		liveAt: null,
		closesAt: Date.now() + DAY,
	});

describe("publish photo checks (SaleEngine)", () => {
	it("[IMG-required] every item needs an approved photo; none, or only rejected, is refused", async () => {
		const none = await makeSale({ status: "draft", photos: "none" });
		expect(rejection(await publishNow(none))).toBe("missing_photos");
		const rejected = await makeSale({ status: "draft", photos: "rejected" });
		expect(rejection(await publishNow(rejected))).toBe("missing_photos");
		expect(await saleRow(rejected.saleId)).toMatchObject({ status: "draft" });
	});

	it("[IMG-required] a photo still being checked doesn't count yet", async () => {
		const sale = await makeSale({ status: "draft", photos: "pending", items: [{}, {}] });
		expect(rejection(await publishNow(sale))).toBe("photos_pending");
		// One approved photo per item is enough, whatever else the item has.
		for (const itemId of sale.itemIds) await addPhoto(sale.saleId, sale.sellerId, itemId, "approved");
		expect(value(await publishNow(sale))).toMatchObject({ status: "live" });
	});

	it("[IMG-dup-review] a photo held for review blocks publishing", async () => {
		const sale = await makeSale({ status: "draft", photos: "review" });
		expect(rejection(await publishNow(sale))).toBe("photos_in_review");
	});

	it("[IMG-timestamp-required] a seller with fewer than 5 completed sales needs an approved timestamp photo", async () => {
		const none = await makeSale({ status: "draft", timestamp: "none" });
		expect(rejection(await publishNow(none))).toBe("timestamp_required");
		for (const [status, code] of [
			["pending", "timestamp_pending"],
			["review", "timestamp_in_review"],
			["rejected", "timestamp_required"],
		] as const) {
			const sale = await makeSale({ status: "draft", timestamp: status });
			expect(rejection(await publishNow(sale))).toBe(code);
		}

		// Five completed sales (closed or archived) make it optional.
		for (let i = 0; i < 5; i++) {
			const done = await makeSale({ status: "closed", sellerId: none.sellerId });
			if (i % 2)
				await db.prepare("UPDATE sales SET status = 'archived' WHERE id = ?1").bind(done.saleId).run();
		}
		expect(value(await publishNow(none))).toMatchObject({ status: "live" });
	});

	it("[IMG-required] the sale's own checks come first (an empty sale is refused as empty)", async () => {
		const empty = await makeSale({ status: "draft", items: [], timestamp: "none" });
		expect(rejection(await publishNow(empty))).toBe("no_items");
		const scheduled = await makeSale({ status: "draft", photos: "approved" });
		const liveAt = Date.now() + HOUR;
		expect(
			value(
				await engine.publishSale({
					saleId: scheduled.saleId,
					sellerId: scheduled.sellerId,
					liveAt,
					closesAt: liveAt + DAY,
				}),
			),
		).toMatchObject({ status: "scheduled" });
	});
});
