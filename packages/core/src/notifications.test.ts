import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MINUTE } from "./common.ts";
import {
	categoryOf,
	describeNotification,
	describeStoredNotification,
	emailPlan,
	followerNotifications,
	matchesWant,
	MESSAGE_EMAIL_DELAY,
	NOTIFICATION_CATEGORIES,
	NOTIFICATION_TYPES,
	notificationsForSaleEvents,
	parseEmailOff,
	parseNotificationPayload,
	referencedIds,
	SELLER_DIGEST_WINDOW,
	sellerDigest,
	wantListNotifications,
	type Listing,
	type NotificationCategory,
	type SaleEventContext,
	type WantListEntry,
} from "./notifications.ts";

const sale = {
	id: "sale-1",
	slug: "weekend-ygo",
	title: "Weekend YGO",
	sellerId: "seller",
	visibility: "public",
	liveAt: 1_000,
};

const context = (overrides: Partial<SaleEventContext> = {}): SaleEventContext => ({
	sale,
	entries: new Map([
		["e-claim", { buyerId: "buyer-a", kind: "claim" as const }],
		["e-offer", { buyerId: "buyer-b", kind: "offer" as const }],
	]),
	items: new Map([["item-1", { title: "Blue-Eyes" }]]),
	invoices: new Map([["inv-1", { buyerId: "buyer-a", totalCents: 4500 }]]),
	...overrides,
});

const map = (events: unknown[], ctx = context()) => notificationsForSaleEvents(events, ctx, "msg-1");

describe("sale events → notifications", () => {
	it("[NOTIF-idempotent] a buyer's win notifies them, keyed by batch and position", () => {
		const { drafts } = map([
			{
				type: "entry_won",
				entryId: "e-claim",
				buyerId: "buyer-a",
				amountCents: 4000,
				via: "instant",
				itemId: "item-1",
			},
		]);
		expect(drafts).toEqual([
			{
				userId: "buyer-a",
				type: "claim_won",
				dedupeKey: "msg-1:0",
				payload: {
					saleId: "sale-1",
					saleSlug: "weekend-ygo",
					saleTitle: "Weekend YGO",
					itemId: "item-1",
					itemTitle: "Blue-Eyes",
					amountCents: 4000,
					kind: "claim",
				},
			},
		]);
	});

	it("[NOTIF-idempotent] the same batch always maps to the same keys", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						type: fc.constantFrom("entry_won", "entry_placed", "invoice_sent", "counter_sent", "noise"),
						entryId: fc.constantFrom("e-claim", "e-offer"),
						buyerId: fc.constant("buyer-a"),
						invoiceId: fc.constant("inv-1"),
						itemId: fc.constant("item-1"),
					}),
				),
				(events) => {
					const a = map(events).drafts.map((d) => d.dedupeKey);
					const b = map(events).drafts.map((d) => d.dedupeKey);
					expect(a).toEqual(b);
					expect(new Set(a).size).toBe(a.length);
				},
			),
		);
	});

	it("maps promotions, counters, declines and seller rescinds to the buyer", () => {
		const { drafts } = map([
			{
				type: "entry_won",
				entryId: "e-offer",
				buyerId: "buyer-b",
				amountCents: 3000,
				via: "promotion",
				itemId: "item-1",
			},
			{ type: "counter_sent", entryId: "e-offer", amountCents: 3500, expiresAt: 99, itemId: "item-1" },
			{ type: "entry_ended", entryId: "e-offer", status: "declined", reason: "declined", itemId: "item-1" },
			{ type: "entry_ended", entryId: "e-claim", status: "withdrawn", reason: "withdrawn", itemId: "item-1" },
			{
				type: "winner_removed",
				entryId: "e-claim",
				buyerId: "buyer-a",
				by: "seller",
				reasonCode: "x",
				itemId: "item-1",
			},
			{
				type: "winner_removed",
				entryId: "e-claim",
				buyerId: "buyer-a",
				by: "buyer",
				reasonCode: null,
				itemId: "item-1",
			},
		]);
		expect(drafts.map((d) => [d.userId, d.type])).toEqual([
			["buyer-b", "claim_promoted"],
			["buyer-b", "offer_countered"],
			["buyer-b", "offer_declined"],
			["buyer-a", "win_rescinded"],
		]);
	});

	it("maps invoice events to the invoice's buyer and payments to the seller", () => {
		const events = [
			"invoice_sent",
			"invoice_overdue",
			"payment_not_received",
			"payment_confirmed",
			"invoice_shipped",
			"buyer_marked_paid",
			"invoice_created",
		].map((type) => ({ type, invoiceId: "inv-1", dueAt: 5 }));
		expect(map(events).drafts.map((d) => [d.userId, d.type])).toEqual([
			["buyer-a", "invoice_sent"],
			["buyer-a", "invoice_overdue"],
			["buyer-a", "payment_not_received"],
			["buyer-a", "payment_confirmed"],
			["buyer-a", "invoice_shipped"],
			["seller", "seller_buyer_paid"],
		]);
		// An invoice the consumer couldn't read tells nobody.
		expect(map([{ type: "invoice_sent", invoiceId: "missing" }]).drafts).toEqual([]);
	});

	it("tells the seller about new claims, offers and decisions, once per entry", () => {
		const { drafts } = map([
			{ type: "entry_placed", entryId: "e-claim", status: "open", itemId: "item-1" },
			{ type: "seller_notified", reason: "claim_needs_decision", itemId: "item-1" },
			{ type: "entry_placed", entryId: "e-offer", status: "open", itemId: "item-1" },
			{ type: "seller_notified", reason: "new_offer", itemId: "item-1" },
			{ type: "seller_notified", reason: "backup_below_asking", itemId: "item-1" },
			{ type: "entry_reopened", entryId: "e-offer", amountCents: 1, itemId: "item-1" },
			{ type: "takeback_requested", requestId: "t", entryId: "e-claim", itemId: "item-1" },
			{ type: "entry_placed", entryId: "unknown", status: "open", itemId: "item-1" },
		]);
		expect(drafts.map((d) => [d.userId, d.type])).toEqual([
			["seller", "seller_new_claim"],
			["seller", "seller_new_offer"],
			["seller", "seller_decision_needed"],
			["seller", "seller_decision_needed"],
			["seller", "seller_takeback_requested"],
		]);
	});

	it("[SM-2-go-live-alarm] going live asks for the followers of a public sale", () => {
		const live = map([{ type: "sale_live" }, { type: "followers_notified" }]).followUps;
		expect(live).toEqual({ followers: "live", matchWantLists: true, sendInvites: false });
		const scheduled = map([{ type: "sale_scheduled", liveAt: 5 }, { type: "followers_notified" }]).followUps;
		expect(scheduled.followers).toBe("scheduled");
		expect(map([{ type: "sale_closed" }]).followUps).toEqual({
			followers: null,
			matchWantLists: false,
			sendInvites: false,
		});
	});

	it("[SM-2-go-live-alarm] unlisted and private sales are never announced to followers", () => {
		for (const visibility of ["unlisted", "private"]) {
			const { followUps } = map(
				[{ type: "sale_live" }, { type: "followers_notified" }],
				context({ sale: { ...sale, visibility } }),
			);
			expect(followUps.followers).toBeNull();
			expect(followUps.matchWantLists).toBe(false);
			expect(followUps.sendInvites).toBe(visibility === "private");
		}
	});

	it("collects the IDs the events refer to", () => {
		expect(
			referencedIds([{ entryId: "e1", itemId: "i1" }, { entryId: "e1", invoiceId: "v1" }, "junk", null]),
		).toEqual({ entryIds: ["e1"], itemIds: ["i1"], invoiceIds: ["v1"] });
	});
});

describe("followers", () => {
	it("[SM-2-go-live-alarm] every follower but the seller is told once per phase", () => {
		const drafts = followerNotifications({ ...sale, sellerName: "Ash" }, ["f1", "seller", "f2"], "live");
		expect(drafts.map((d) => [d.userId, d.type, d.dedupeKey])).toEqual([
			["f1", "followed_sale_live", "follow:sale-1:live:f1"],
			["f2", "followed_sale_live", "follow:sale-1:live:f2"],
		]);
		expect(followerNotifications({ ...sale, sellerName: "Ash" }, ["f1"], "scheduled")[0]?.type).toBe(
			"followed_sale_scheduled",
		);
	});
});

describe("want lists", () => {
	const want: WantListEntry = {
		id: "w1",
		userId: "collector",
		productId: 42,
		finish: null,
		maxPriceCents: null,
		minCondition: null,
		language: null,
	};
	const listing: Listing = {
		itemId: "item-1",
		title: "Charizard",
		catalogProductId: "42",
		kind: "single",
		finish: "holo",
		condition: "LP",
		language: null,
		priceCents: 5000,
	};

	it("[TCG-want-list-notify] matches on product, finish, condition, price and language", () => {
		expect(matchesWant(want, listing)).toBe(true);
		expect(matchesWant(want, { ...listing, catalogProductId: "43" })).toBe(false);
		expect(matchesWant(want, { ...listing, catalogProductId: null })).toBe(false);
		expect(matchesWant({ ...want, finish: "holo" }, listing)).toBe(true);
		expect(matchesWant({ ...want, finish: "reverse-holo" }, listing)).toBe(false);
		expect(matchesWant({ ...want, minCondition: "LP" }, listing)).toBe(true);
		expect(matchesWant({ ...want, minCondition: "NM" }, listing)).toBe(false);
		expect(matchesWant({ ...want, minCondition: "NM" }, { ...listing, condition: null })).toBe(false);
		expect(
			matchesWant({ ...want, minCondition: "NM" }, { ...listing, kind: "sealed", condition: null }),
		).toBe(true);
		expect(matchesWant({ ...want, maxPriceCents: 5000 }, listing)).toBe(true);
		expect(matchesWant({ ...want, maxPriceCents: 4999 }, listing)).toBe(false);
		expect(matchesWant({ ...want, language: "en" }, listing)).toBe(true);
		expect(matchesWant({ ...want, language: "ja" }, listing)).toBe(false);
		expect(matchesWant({ ...want, language: "ja" }, { ...listing, language: "ja" })).toBe(true);
	});

	it("[TCG-want-list-notify] a stricter minimum condition never matches more listings", () => {
		const conditions = ["NM", "LP", "MP", "HP", "DMG"];
		fc.assert(
			fc.property(fc.constantFrom(...conditions), fc.constantFrom(...conditions), (min, cond) => {
				const strictest = matchesWant({ ...want, minCondition: "NM" }, { ...listing, condition: cond });
				const chosen = matchesWant({ ...want, minCondition: min }, { ...listing, condition: cond });
				expect(!strictest || chosen).toBe(true);
			}),
		);
	});

	it("[TCG-want-list-notify] each match is keyed once per want and item; the seller is never told", () => {
		const drafts = wantListNotifications(
			sale,
			[want, { ...want, id: "w2", userId: "seller" }],
			[listing, { ...listing, itemId: "item-2", catalogProductId: "7" }],
		);
		expect(drafts).toEqual([
			expect.objectContaining({ userId: "collector", type: "want_list_match", dedupeKey: "want:w1:item-1" }),
		]);
		expect(drafts[0]?.payload).toMatchObject({ itemTitle: "Charizard", priceCents: 5000 });
	});
});

describe("email decisions", () => {
	const on = { emailVerified: true, emailOff: new Set<NotificationCategory>() };

	it("[NOTIF-preferences] email goes out only for categories left on, to a verified address", () => {
		expect(emailPlan("claim_won", on, 0)).toEqual({ status: "pending", dueAt: null });
		expect(emailPlan("claim_won", { ...on, emailOff: new Set(["purchases"]) }, 0)).toEqual({
			status: "off",
			dueAt: null,
		});
		expect(emailPlan("claim_won", { ...on, emailVerified: false }, 0)).toEqual({
			status: "skipped",
			dueAt: null,
		});
	});

	it("[NOTIF-seller-batch] seller activity waits for the digest window", () => {
		expect(emailPlan("seller_new_claim", on, 1000)).toEqual({
			status: "batched",
			dueAt: 1000 + SELLER_DIGEST_WINDOW,
		});
		expect(SELLER_DIGEST_WINDOW).toBe(5 * MINUTE);
	});

	it("[MSG-email-unread] a message's email waits for the unread delay", () => {
		expect(emailPlan("new_message", on, 1000)).toEqual({
			status: "pending",
			dueAt: 1000 + MESSAGE_EMAIL_DELAY,
		});
	});

	it("[NOTIF-preferences] reads stored preferences defensively", () => {
		expect(parseEmailOff('["selling","nope"]')).toEqual(new Set(["selling"]));
		expect(parseEmailOff(["messages"])).toEqual(new Set(["messages"]));
		expect(parseEmailOff("not json")).toEqual(new Set());
		expect(parseEmailOff({ selling: false })).toEqual(new Set());
		expect(parseEmailOff(null)).toEqual(new Set());
	});

	it("every type has a category and copy with a site-relative link", () => {
		for (const type of NOTIFICATION_TYPES) {
			expect(NOTIFICATION_CATEGORIES).toContain(categoryOf(type));
			const copy = describeNotification(type, {
				saleId: "s",
				saleSlug: "slug",
				saleTitle: "Sale",
				itemId: "i",
				itemTitle: "Item",
				amountCents: 100,
				totalCents: 200,
				priceCents: 300,
				liveAt: 0,
				conversationId: "c",
				senderName: "Ash",
				sellerName: "Ash",
			});
			expect(copy.title).not.toBe("");
			expect(copy.body).not.toBe("");
			expect(copy.path.startsWith("/")).toBe(true);
		}
	});

	it("reads stored payloads defensively", () => {
		expect(parseNotificationPayload('{"a":"x","b":2,"c":null,"d":{"nested":1},"e":[1]}')).toEqual({
			a: "x",
			b: 2,
			c: null,
		});
		expect(parseNotificationPayload({ a: "x" })).toEqual({ a: "x" });
		expect(parseNotificationPayload("not json")).toEqual({});
		expect(parseNotificationPayload("[1]")).toEqual({});
		expect(parseNotificationPayload(null)).toEqual({});
	});

	it("an unknown stored type still renders", () => {
		expect(describeNotification("from_the_future" as never, {}).path).toBe("/me/notifications");
		expect(describeStoredNotification("from_the_future", "{}").title).toBe("ClaimSale update");
		expect(describeStoredNotification("claim_won", '{"itemTitle":"Mew"}').title).toBe("You won “Mew”");
	});

	it("copy degrades gracefully when payload fields are missing", () => {
		expect(describeNotification("claim_won", {}).title).toBe("You won “an item”");
		expect(describeNotification("invoice_sent", { totalCents: null }).body).toMatch(
			/^Your invoice is ready./,
		);
		expect(describeNotification("claim_won", {}).body).not.toContain(" at ");
		expect(describeNotification("followed_sale_scheduled", {}).body).toContain("goes live soon");
		expect(describeNotification("seller_decision_needed", { reason: "counter_accepted" }).body).toContain(
			"accepted your counter",
		);
	});
});

describe("seller digest", () => {
	it("[NOTIF-seller-batch] many claims become one email with counts", () => {
		const rows = Array.from({ length: 12 }, () => ({
			type: "seller_new_claim" as const,
			payload: { saleId: "s1", saleTitle: "Weekend YGO" },
		}));
		expect(sellerDigest(rows)).toEqual({
			subject: "12 new claims in the last few minutes",
			lines: ["“Weekend YGO”: 12 new claims"],
			path: "/sell/s1",
		});
	});

	it("[NOTIF-seller-batch] mixed activity across sales is summarised per sale", () => {
		const digest = sellerDigest([
			{ type: "seller_new_claim", payload: { saleId: "s1", saleTitle: "A" } },
			{ type: "seller_new_offer", payload: { saleId: "s1", saleTitle: "A" } },
			{ type: "seller_new_offer", payload: { saleId: "s1", saleTitle: "A" } },
			{ type: "seller_buyer_paid", payload: { saleId: "s2", saleTitle: "B" } },
			{ type: "seller_takeback_requested", payload: { saleId: "s2", saleTitle: "B" } },
			{ type: "seller_decision_needed", payload: { saleId: "s2", saleTitle: "B" } },
			{ type: "claim_won", payload: { saleId: "s2", saleTitle: "B" } },
		]);
		expect(digest.subject).toBe("7 updates on your sales");
		expect(digest.lines).toEqual([
			"“A”: 1 new claim, 2 new offers",
			"“B”: 1 payment to confirm, 1 take-back request, 1 decision needed, 1 update",
		]);
		expect(digest.path).toBe("/sell");
		expect(
			sellerDigest([{ type: "seller_new_claim", payload: { saleId: "s1", saleTitle: "A" } }]).subject,
		).toBe("1 new claim in the last few minutes");
	});
});
