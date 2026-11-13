import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "./common.ts";
import { decisionWindow, paymentDeadline } from "./plans.ts";
import {
	acceptsEntries,
	archive,
	canAddItem,
	close,
	deleteSale,
	editableItemFields,
	goLive,
	isVisible,
	publish,
	unpublish,
} from "./sale.ts";
import { expectOk, expectRejected, makeSale, T0 } from "./testing.ts";

const closesAt = T0 + 3 * DAY;

describe("sale lifecycle", () => {
	it("[SM-2-publish-scheduled] a future live_at schedules the sale and keeps claims closed", () => {
		const { sale, events } = expectOk(
			publish(makeSale(), { liveAt: T0 + DAY, closesAt, activeSaleCount: 0 }, T0),
		);
		expect(sale).toMatchObject({ status: "scheduled", liveAt: T0 + DAY, closesAt });
		expect(events).toContainEqual({ type: "sale_scheduled", liveAt: T0 + DAY });
		expect(isVisible(sale.status)).toBe(true);
		expect(acceptsEntries(sale.status)).toBe(false);
	});

	it("[SM-2-publish-now] no live_at puts the sale live now", () => {
		const { sale, events } = expectOk(
			publish(makeSale(), { liveAt: null, closesAt, activeSaleCount: 0 }, T0),
		);
		expect(sale).toMatchObject({ status: "live", liveAt: T0 });
		expect(events).toEqual([{ type: "sale_live" }, { type: "followers_notified" }]);
		expect(acceptsEntries(sale.status)).toBe(true);
	});

	it("[SM-2-publish-now] rejects a past go-live time, a close before go-live, an empty sale and a non-draft", () => {
		expect(expectRejected(publish(makeSale(), { liveAt: T0 - 1, closesAt, activeSaleCount: 0 }, T0))).toBe(
			"live_at_in_past",
		);
		expect(expectRejected(publish(makeSale(), { liveAt: null, closesAt: T0, activeSaleCount: 0 }, T0))).toBe(
			"closes_before_live",
		);
		expect(
			expectRejected(publish(makeSale({ itemCount: 0 }), { liveAt: null, closesAt, activeSaleCount: 0 }, T0)),
		).toBe("no_items");
		expect(
			expectRejected(
				publish(makeSale({ status: "live" }), { liveAt: null, closesAt, activeSaleCount: 0 }, T0),
			),
		).toBe("invalid_status");
	});

	it("[SM-2-preview-window] go-live can be at most 7 days ahead", () => {
		expectOk(publish(makeSale(), { liveAt: T0 + 7 * DAY, closesAt: T0 + 8 * DAY, activeSaleCount: 0 }, T0));
		expect(
			expectRejected(
				publish(makeSale(), { liveAt: T0 + 7 * DAY + 1, closesAt: T0 + 8 * DAY, activeSaleCount: 0 }, T0),
			),
		).toBe("preview_too_early");
	});

	it("[SM-2-max-duration] a sale runs live at most 14 days", () => {
		expectOk(publish(makeSale(), { liveAt: null, closesAt: T0 + 14 * DAY, activeSaleCount: 0 }, T0));
		expect(
			expectRejected(
				publish(makeSale(), { liveAt: null, closesAt: T0 + 14 * DAY + 1, activeSaleCount: 0 }, T0),
			),
		).toBe("too_long");
		expect(
			expectRejected(
				publish(makeSale(), { liveAt: T0 + DAY, closesAt: T0 + 15 * DAY + 1, activeSaleCount: 0 }, T0),
			),
		).toBe("too_long");
	});

	it("[SM-2-free-sale-cap] free sellers can have two sales scheduled or live; Pro sellers more", () => {
		const command = { liveAt: null, closesAt, activeSaleCount: 2 };
		expect(expectRejected(publish(makeSale(), command, T0))).toBe("sale_cap_reached");
		expectOk(publish(makeSale(), { ...command, activeSaleCount: 1 }, T0));
		expectOk(publish(makeSale({ sellerTier: "pro" }), { ...command, activeSaleCount: 5 }, T0));
	});

	it("[SM-2-free-item-cap] free sales hold at most 10 items, checked on add and on publish", () => {
		expectOk(canAddItem(makeSale({ itemCount: 9 })));
		expect(expectRejected(canAddItem(makeSale({ itemCount: 10 })))).toBe("item_cap_reached");
		expectOk(canAddItem(makeSale({ itemCount: 50, sellerTier: "pro" })));
		expect(expectRejected(canAddItem(makeSale({ status: "live" })))).toBe("invalid_status");
		expect(
			expectRejected(
				publish(makeSale({ itemCount: 11 }), { liveAt: null, closesAt, activeSaleCount: 0 }, T0),
			),
		).toBe("item_cap_reached");
	});

	it("[SM-2-go-live-alarm] the alarm at live_at puts the sale live and notifies followers", () => {
		const scheduled = makeSale({ status: "scheduled", liveAt: T0 + HOUR, closesAt });
		expect(expectRejected(goLive(scheduled, T0))).toBe("invalid_status");
		const { sale, events } = expectOk(goLive(scheduled, T0 + HOUR));
		expect(sale.status).toBe("live");
		expect(events).toContainEqual({ type: "followers_notified" });
	});

	it("[SM-2-publish-scheduled] unpublishing a scheduled sale returns it to draft", () => {
		const { sale } = expectOk(unpublish(makeSale({ status: "scheduled", liveAt: T0 + HOUR, closesAt })));
		expect(sale).toMatchObject({ status: "draft", liveAt: null, closesAt: null });
		expect(expectRejected(unpublish(makeSale({ status: "live" })))).toBe("invalid_status");
	});

	it("[SM-2-close] the seller or the alarm closes a live sale, which then rejects new entries", () => {
		const live = makeSale({ status: "live", liveAt: T0, closesAt });
		const bySeller = expectOk(close(live, T0 + HOUR, "seller"));
		expect(bySeller.sale).toMatchObject({ status: "closed", closesAt: T0 + HOUR });
		expect(acceptsEntries(bySeller.sale.status)).toBe(false);
		expect(expectRejected(close(live, T0 + HOUR, "alarm"))).toBe("invalid_status");
		expect(expectOk(close(live, closesAt, "alarm")).sale.closesAt).toBe(closesAt);
		expect(expectRejected(close(makeSale(), T0, "seller"))).toBe("invalid_status");
	});

	it("archives a closed sale once invoices are done, or after 90 days", () => {
		const closed = makeSale({ status: "closed", closesAt: T0 });
		expect(expectRejected(archive(closed, 1, T0 + DAY))).toBe("invoices_open");
		expectOk(archive(closed, 0, T0 + DAY));
		expectOk(archive(closed, 3, T0 + 90 * DAY));
		expect(expectRejected(archive(makeSale(), 0, T0))).toBe("invalid_status");
	});

	it("deletes only drafts", () => {
		expect(expectOk(deleteSale(makeSale())).sale.status).toBe("deleted");
		expect(expectRejected(deleteSale(makeSale({ status: "live" })))).toBe("invalid_status");
		expect(isVisible("draft")).toBe(false);
	});

	it("[SM-2-lock-price-qty] price and quantity lock once an item has entries; title and photos don't", () => {
		expect(editableItemFields(0)).toEqual(new Set(["title", "description", "photos", "price", "quantity"]));
		expect(editableItemFields(1)).toEqual(new Set(["title", "description", "photos"]));
	});
});

describe("plan timings", () => {
	it("[SM-4.2-window-length] free sellers get 24h; Pro sellers their own positive window", () => {
		expect(decisionWindow("free", 2 * HOUR)).toBe(24 * HOUR);
		expect(decisionWindow("pro")).toBe(24 * HOUR);
		expect(decisionWindow("pro", 6 * HOUR)).toBe(6 * HOUR);
		expect(decisionWindow("pro", 0)).toBe(24 * HOUR);
	});

	it("[SM-6-payment-deadline] 48h by default; only Pro sellers can choose 24h", () => {
		expect(paymentDeadline("free", true)).toBe(48 * HOUR);
		expect(paymentDeadline("pro", false)).toBe(48 * HOUR);
		expect(paymentDeadline("pro", true)).toBe(24 * HOUR);
	});
});
