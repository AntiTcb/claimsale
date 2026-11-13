import { describe, expect, it } from "vitest";
import { HOUR } from "./common.ts";
import {
	award,
	buyerRescind,
	closeItem,
	compareRank,
	counter,
	declineOffer,
	deriveItemState,
	expireCounter,
	expireDecisionWindow,
	freeUnits,
	fulfill,
	lapseOffersAfterClose,
	loseBackups,
	place,
	promote,
	rankedOpenEntries,
	releaseForTakeback,
	reorder,
	respondToCounter,
	sellerRescind,
	withdraw,
	withdrawItem,
	type Item,
	type ItemContext,
	type PlaceCommand,
} from "./item.ts";
import {
	buyerActor,
	expectOk,
	expectRejected,
	makeBuyer,
	makeContext,
	makeEntry,
	makeItem,
	seller,
	SELLER,
	T0,
} from "./testing.ts";

const ctx = makeContext();
const claim = (id: string): PlaceCommand => ({ entryId: id, kind: "claim" });
const offer = (id: string, amountCents: number): PlaceCommand => ({
	entryId: id,
	kind: "offer",
	amountCents,
});

/** Places entries in order, one minute apart, failing on any rejection. */
function placeAll(item: Item, steps: Array<[buyer: string, PlaceCommand]>, context: ItemContext = ctx): Item {
	return steps.reduce(
		(acc, [buyer, command], i) =>
			expectOk(place(acc, context, makeBuyer(buyer), command, T0 + i * 60_000)).item,
		item,
	);
}

const statusOf = (item: Item, entryId: string) => item.entries.find((e) => e.id === entryId)?.status;

const rescindCommand = (entryId: string, passToNext: boolean) => ({
	entryId,
	reasonCode: "buyer_nonpayment" as const,
	explanation: "No payment after two reminders.",
	passToNext,
	afterBuyerPaid: false,
	confirmed: false,
});

describe("placing a claim", () => {
	it("[SM-4.1-instant-win] wins at once with a free unit, no pending offers, no review mode and no deadline", () => {
		const { item, events } = expectOk(place(makeItem(), ctx, makeBuyer("b1"), claim("e1"), T0));
		expect(item.entries[0]).toMatchObject({ status: "won", amountCents: 4000, wonAt: T0 });
		expect(events).toEqual([
			{ type: "entry_won", entryId: "e1", buyerId: "b1", amountCents: 4000, via: "instant" },
		]);
		expect(deriveItemState(item, "live")).toBe("sold_out");
	});

	it("[SM-4.1-instant-win] a claim is always at the asking price, whatever amount is sent", () => {
		const { item } = expectOk(
			place(makeItem(), ctx, makeBuyer("b1"), { entryId: "e1", kind: "claim", amountCents: 1 }, T0),
		);
		expect(item.entries[0]?.amountCents).toBe(4000);
	});

	it("[SM-4.1-deciding] with a pending offer, the claim waits and starts the decision window", () => {
		const withOffer = placeAll(makeItem(), [["b1", offer("o1", 3500)]]);
		const { item, events } = expectOk(place(withOffer, ctx, makeBuyer("b2"), claim("c1"), T0 + HOUR));
		expect(statusOf(item, "c1")).toBe("open");
		expect(item.decisionDeadline).toBe(T0 + HOUR + 24 * HOUR);
		expect(events).toContainEqual({ type: "seller_notified", reason: "claim_needs_decision" });
		expect(deriveItemState(item, "live")).toBe("deciding");
	});

	it("[SM-4.1-deciding] with review mode on, every claim waits; a second claim keeps the first deadline", () => {
		const review = makeContext({ reviewEveryClaim: true });
		const item = placeAll(
			makeItem({ quantity: 2 }),
			[
				["b1", claim("c1")],
				["b2", claim("c2")],
			],
			review,
		);
		expect(item.entries.map((e) => e.status)).toEqual(["open", "open"]);
		expect(item.decisionDeadline).toBe(T0 + 24 * HOUR);
	});

	it("[SM-4.1-deciding] a countered offer still counts as pending", () => {
		const item = makeItem({
			entries: [
				makeEntry({
					id: "o1",
					buyerId: "b1",
					kind: "offer",
					amountCents: 3000,
					status: "countered",
					counterCents: 3800,
				}),
			],
		});
		const { item: next } = expectOk(place(item, ctx, makeBuyer("b2"), claim("c1"), T0));
		expect(statusOf(next, "c1")).toBe("open");
	});

	it("[SM-4.1-backup-claim] a claim on a sold-out item is an open backup and starts no window", () => {
		const soldOut = placeAll(makeItem(), [["b1", claim("c1")]]);
		const { item, events } = expectOk(place(soldOut, ctx, makeBuyer("b2"), claim("c2"), T0 + HOUR));
		expect(statusOf(item, "c2")).toBe("open");
		expect(item.decisionDeadline).toBeNull();
		expect(events).toEqual([{ type: "entry_placed", entryId: "c2", status: "open" }]);
	});
});

describe("placing an offer", () => {
	it("[SM-4.1-offer-open] an offer opens, never wins on its own, and starts no window, even above asking", () => {
		const { item, events } = expectOk(place(makeItem(), ctx, makeBuyer("b1"), offer("o1", 9000), T0));
		expect(item.entries[0]).toMatchObject({ status: "open", amountCents: 9000 });
		expect(item.decisionDeadline).toBeNull();
		expect(events).toContainEqual({ type: "seller_notified", reason: "new_offer" });
		expect(deriveItemState(item, "live")).toBe("available");
	});

	it("[SM-4.1-offer-open] rejects offers when the item takes none, and invalid amounts", () => {
		expect(
			expectRejected(place(makeItem({ offersEnabled: false }), ctx, makeBuyer("b1"), offer("o1", 100), T0)),
		).toBe("offers_disabled");
		for (const amount of [0, -5, 1.5]) {
			expect(expectRejected(place(makeItem(), ctx, makeBuyer("b1"), offer("o1", amount), T0))).toBe(
				"invalid_amount",
			);
		}
		expect(
			expectRejected(place(makeItem(), ctx, makeBuyer("b1"), { entryId: "o1", kind: "offer" }, T0)),
		).toBe("invalid_amount");
	});

	it("[SM-4.1-backup-offer-toggle] offers on sold-out items follow the per-sale toggle", () => {
		const soldOut = placeAll(makeItem(), [["b1", claim("c1")]]);
		expectOk(place(soldOut, ctx, makeBuyer("b2"), offer("o1", 4500), T0));
		const off = makeContext({ allowBackupOffers: false });
		expect(expectRejected(place(soldOut, off, makeBuyer("b2"), offer("o1", 4500), T0))).toBe(
			"backup_offers_disabled",
		);
	});

	it("[SM-4.1-min-offer] a Pro seller's hidden minimum auto-declines lower offers", () => {
		const pro = makeContext({ sellerTier: "pro" });
		const item = makeItem({ minOfferCents: 3000 });
		const low = expectOk(place(item, pro, makeBuyer("b1"), offer("o1", 2999), T0));
		expect(low.item.entries[0]).toMatchObject({
			status: "declined",
			endedReason: "below_minimum",
			endedBy: "system",
		});
		expect(low.events).toEqual([
			{ type: "entry_ended", entryId: "o1", status: "declined", reason: "below_minimum" },
		]);
		expect(statusOf(expectOk(place(item, pro, makeBuyer("b1"), offer("o1", 3000), T0)).item, "o1")).toBe(
			"open",
		);
	});

	it("[SM-4.1-min-offer] the hidden minimum does nothing for free sellers", () => {
		const { item } = expectOk(
			place(makeItem({ minOfferCents: 3000 }), ctx, makeBuyer("b1"), offer("o1", 100), T0),
		);
		expect(statusOf(item, "o1")).toBe("open");
	});
});

describe("placing: guards", () => {
	it("[SM-4.1-one-open-entry] a buyer can't hold two pending entries on one item", () => {
		const item = placeAll(makeItem(), [["b1", offer("o1", 3000)]]);
		expect(expectRejected(place(item, ctx, makeBuyer("b1"), claim("c1"), T0))).toBe("already_entered");
		expect(expectRejected(place(item, ctx, makeBuyer("b1"), offer("o2", 3100), T0))).toBe("already_entered");
	});

	it("[SM-4.1-unit-limit] the per-buyer unit limit counts the buyer's wins", () => {
		const item = placeAll(makeItem({ quantity: 3, perBuyerLimit: 2 }), [
			["b1", claim("c1")],
			["b1", claim("c2")],
		]);
		expect(item.entries.map((e) => e.status)).toEqual(["won", "won"]);
		expect(expectRejected(place(item, ctx, makeBuyer("b1"), claim("c3"), T0))).toBe("unit_limit_reached");
		expectOk(place(item, ctx, makeBuyer("b2"), claim("c3"), T0));
	});

	it("[SM-4.1-buyer-requirements] blocked, unverified and too-new buyers are rejected; Pro buyers skip verification and age", () => {
		const strict = makeContext({ buyerRequirements: { emailVerified: true, minAccountAge: 30 * 24 * HOUR } });
		const item = makeItem();
		expect(expectRejected(place(item, strict, makeBuyer("b1", { blocked: true }), claim("c1"), T0))).toBe(
			"buyer_blocked",
		);
		expect(
			expectRejected(place(item, strict, makeBuyer("b1", { emailVerified: false }), claim("c1"), T0)),
		).toBe("email_not_verified");
		expect(
			expectRejected(place(item, strict, makeBuyer("b1", { accountCreatedAt: T0 - HOUR }), claim("c1"), T0)),
		).toBe("account_too_new");
		const proNewbie = makeBuyer("b1", { tier: "pro", emailVerified: false, accountCreatedAt: T0 - HOUR });
		expectOk(place(item, strict, proNewbie, claim("c1"), T0));
		expect(
			expectRejected(place(item, strict, makeBuyer("b1", { tier: "pro", blocked: true }), claim("c1"), T0)),
		).toBe("buyer_blocked");
		const lax = makeContext({ buyerRequirements: { emailVerified: false, minAccountAge: 0 } });
		expectOk(place(item, lax, makeBuyer("b1", { emailVerified: false }), claim("c1"), T0));
	});

	it("[SM-2-close] entries are rejected unless the sale is live", () => {
		for (const saleStatus of ["draft", "scheduled", "closed", "archived"] as const) {
			expect(
				expectRejected(place(makeItem(), makeContext({ saleStatus }), makeBuyer("b1"), claim("c1"), T0)),
			).toBe("sale_not_live");
		}
	});

	it("[SM-8-permissions] the seller can't enter their own item, and nobody can enter a withdrawn one", () => {
		expect(expectRejected(place(makeItem(), ctx, makeBuyer(SELLER), claim("c1"), T0))).toBe("not_allowed");
		expect(expectRejected(place(makeItem({ withdrawn: true }), ctx, makeBuyer("b1"), claim("c1"), T0))).toBe(
			"item_withdrawn",
		);
	});
});

describe("ranking", () => {
	it("[SM-4.2-ranking] amount descending, then time ascending, then ID", () => {
		const entries = [
			makeEntry({ id: "a", buyerId: "1", amountCents: 3500, createdAt: T0 }),
			makeEntry({ id: "b", buyerId: "2", amountCents: 4000, createdAt: T0 + 2 }),
			makeEntry({ id: "c", buyerId: "3", amountCents: 4500, createdAt: T0 + 3 }),
			makeEntry({ id: "d", buyerId: "4", amountCents: 4000, createdAt: T0 + 1 }),
			makeEntry({ id: "e", buyerId: "5", amountCents: 4000, createdAt: T0 + 1 }),
		];
		expect(rankedOpenEntries(makeItem({ entries })).map((e) => e.id)).toEqual(["c", "d", "e", "b", "a"]);
		expect(compareRank(entries[0]!, entries[0]!)).toBe(0);
	});

	it("[SM-4.2-ranking] the seller can reorder open entries; reordered ones come first", () => {
		const item = makeItem({
			entries: [
				makeEntry({ id: "a", buyerId: "1", amountCents: 5000 }),
				makeEntry({ id: "b", buyerId: "2", amountCents: 4000 }),
				makeEntry({ id: "c", buyerId: "3", amountCents: 3000 }),
			],
		});
		const { item: next } = expectOk(reorder(item, ctx, seller(), ["c", "b"]));
		expect(rankedOpenEntries(next).map((e) => e.id)).toEqual(["c", "b", "a"]);
		expect(expectRejected(reorder(item, ctx, seller(), ["c", "c"]))).toBe("invalid_status");
		expect(expectRejected(reorder(item, ctx, seller(), ["zzz"]))).toBe("invalid_status");
		expect(expectRejected(reorder(item, ctx, buyerActor("1"), ["a"]))).toBe("not_allowed");
	});
});

const deciding = () =>
	placeAll(makeItem(), [
		["b1", offer("o1", 4500)],
		["b2", claim("c1")],
	]);

describe("awarding", () => {
	it("[SM-4.2-award] the seller awards an open entry; the others become backups and the deadline clears", () => {
		const { item, events } = expectOk(award(deciding(), ctx, seller(), "o1", T0 + HOUR));
		expect(statusOf(item, "o1")).toBe("won");
		expect(statusOf(item, "c1")).toBe("open");
		expect(item.decisionDeadline).toBeNull();
		expect(events).toContainEqual({ type: "decision_deadline_cleared" });
		expect(deriveItemState(item, "live")).toBe("sold_out");
	});

	it("[SM-4.2-award] needs a free unit and an open entry, and only the seller can do it", () => {
		const won = expectOk(award(deciding(), ctx, seller(), "o1", T0)).item;
		expect(expectRejected(award(won, ctx, seller(), "c1", T0))).toBe("no_free_unit");
		expect(expectRejected(award(won, ctx, seller(), "o1", T0))).toBe("invalid_status");
		expect(expectRejected(award(deciding(), ctx, seller(), "nope", T0))).toBe("entry_not_found");
		expect(expectRejected(award(deciding(), ctx, buyerActor("b2"), "c1", T0))).toBe("not_allowed");
		expect(
			expectRejected(award(deciding(), ctx, { kind: "seller", id: "other", tier: "pro" }, "c1", T0)),
		).toBe("not_allowed");
	});

	it("[SM-4.2-award] the deadline stays while units are free and claims remain", () => {
		const item = placeAll(makeItem({ quantity: 3 }), [
			["b1", offer("o1", 4500)],
			["b2", claim("c1")],
			["b3", claim("c2")],
		]);
		const { item: next } = expectOk(award(item, ctx, seller(), "c1", T0));
		expect(next.decisionDeadline).not.toBeNull();
	});

	it("[SM-4.2-window-expiry] the earliest open claims win, never an offer, and the deadline clears", () => {
		const item = placeAll(makeItem({ quantity: 2 }), [
			["b1", offer("o1", 9000)],
			["b2", claim("c1")],
			["b3", claim("c2")],
			["b4", claim("c3")],
		]);
		expect(expectRejected(expireDecisionWindow(item, T0))).toBe("not_due");
		const { item: next, events } = expectOk(expireDecisionWindow(item, item.decisionDeadline!));
		expect([statusOf(next, "o1"), statusOf(next, "c1"), statusOf(next, "c2"), statusOf(next, "c3")]).toEqual([
			"open",
			"won",
			"won",
			"open",
		]);
		expect(next.decisionDeadline).toBeNull();
		expect(events.filter((e) => e.type === "entry_won").map((e) => e.type === "entry_won" && e.via)).toEqual([
			"window",
			"window",
		]);
	});

	it("[SM-4.2-window-expiry] with only offers left, nothing wins and the offers stay open", () => {
		const item = makeItem({
			decisionDeadline: T0,
			entries: [makeEntry({ id: "o1", buyerId: "b1", kind: "offer", amountCents: 9999 })],
		});
		const { item: next } = expectOk(expireDecisionWindow(item, T0));
		expect(statusOf(next, "o1")).toBe("open");
		expect(deriveItemState(next, "live")).toBe("available");
	});
});

const withOffer = () => placeAll(makeItem(), [["b1", offer("o1", 3000)]]);

describe("counter-offers", () => {
	it("[SM-4.4-counter] the seller counters once; the counter is open for 24h", () => {
		const { item, events } = expectOk(counter(withOffer(), ctx, seller(), "o1", 3800, T0));
		expect(item.entries[0]).toMatchObject({
			status: "countered",
			counterCents: 3800,
			counterExpiresAt: T0 + 24 * HOUR,
		});
		expect(events).toEqual([
			{ type: "counter_sent", entryId: "o1", amountCents: 3800, expiresAt: T0 + 24 * HOUR },
		]);
		expect(expectRejected(counter(item, ctx, seller(), "o1", 3700, T0))).toBe("invalid_status");
	});

	it("[SM-4.4-counter] accepting with a free unit wins at the counter amount", () => {
		const countered = expectOk(counter(withOffer(), ctx, seller(), "o1", 3800, T0)).item;
		const { item, events } = expectOk(respondToCounter(countered, buyerActor("b1"), "o1", true, T0 + HOUR));
		expect(item.entries[0]).toMatchObject({ status: "won", amountCents: 3800 });
		expect(events[0]).toMatchObject({ type: "entry_won", via: "counter" });
	});

	it("[SM-4.4-counter] accepting when no unit is free reopens the entry at the counter amount, ranked by it", () => {
		const item = placeAll(makeItem(), [
			["b1", offer("o1", 3000)],
			["b2", offer("o2", 3500)],
		]);
		const countered = expectOk(counter(item, ctx, seller(), "o1", 3800, T0)).item;
		const sold = expectOk(award(countered, ctx, seller(), "o2", T0)).item;
		const { item: next, events } = expectOk(respondToCounter(sold, buyerActor("b1"), "o1", true, T0 + HOUR));
		expect(next.entries[0]).toMatchObject({ status: "open", amountCents: 3800, counterCents: 3800 });
		expect(events).toEqual([{ type: "entry_reopened", entryId: "o1", amountCents: 3800 }]);
		expect(expectRejected(counter(next, ctx, seller(), "o1", 3900, T0))).toBe("already_countered");
	});

	it("[SM-4.4-counter] declining ends the entry; only the buyer answers, and only before expiry", () => {
		const countered = expectOk(counter(withOffer(), ctx, seller(), "o1", 3800, T0)).item;
		expect(expectRejected(respondToCounter(countered, buyerActor("b2"), "o1", true, T0))).toBe("not_allowed");
		expect(expectRejected(respondToCounter(countered, buyerActor("b1"), "o1", true, T0 + 24 * HOUR))).toBe(
			"counter_expired",
		);
		expect(expectRejected(respondToCounter(withOffer(), buyerActor("b1"), "o1", true, T0))).toBe(
			"invalid_status",
		);
		const { item } = expectOk(respondToCounter(countered, buyerActor("b1"), "o1", false, T0));
		expect(item.entries[0]).toMatchObject({
			status: "declined",
			endedReason: "counter_declined",
			endedBy: "b1",
		});
	});

	it("[SM-4.4-counter] only open offers can be countered, with a positive amount, by the seller", () => {
		const item = placeAll(makeItem(), [["b1", claim("c1")]]);
		expect(expectRejected(counter(item, ctx, seller(), "c1", 100, T0))).toBe("invalid_status");
		expect(expectRejected(counter(withOffer(), ctx, seller(), "o1", 0, T0))).toBe("invalid_amount");
		expect(expectRejected(counter(withOffer(), ctx, buyerActor("b1"), "o1", 100, T0))).toBe("not_allowed");
	});

	it("[SM-4.4-counter-expiry] an unanswered counter is declined after 24h", () => {
		const countered = expectOk(counter(withOffer(), ctx, seller(), "o1", 3800, T0)).item;
		expect(expectRejected(expireCounter(countered, "o1", T0 + HOUR))).toBe("not_due");
		const { item } = expectOk(expireCounter(countered, "o1", T0 + 24 * HOUR));
		expect(item.entries[0]).toMatchObject({
			status: "declined",
			endedReason: "counter_expired",
			endedBy: "system",
		});
	});

	it("the seller declines a pending offer, but not a claim", () => {
		const { item } = expectOk(declineOffer(withOffer(), ctx, seller(), "o1", T0));
		expect(item.entries[0]).toMatchObject({
			status: "declined",
			endedReason: "seller_declined",
			endedBy: SELLER,
		});
		const claimed = placeAll(makeItem(), [["b1", claim("c1")]]);
		expect(expectRejected(declineOffer(claimed, ctx, seller(), "c1", T0))).toBe("invalid_status");
		expect(expectRejected(declineOffer(withOffer(), ctx, buyerActor("b1"), "o1", T0))).toBe("not_allowed");
	});
});

describe("withdrawing", () => {
	it("[SM-4.4-withdraw-offer] the buyer withdraws a pending offer until it's accepted", () => {
		const item = placeAll(makeItem(), [["b1", offer("o1", 3000)]]);
		const { item: next } = expectOk(withdraw(item, buyerActor("b1"), "o1", T0));
		expect(next.entries[0]).toMatchObject({ status: "withdrawn", endedReason: "buyer_withdrew" });
		const won = expectOk(award(item, ctx, seller(), "o1", T0)).item;
		expect(expectRejected(withdraw(won, buyerActor("b1"), "o1", T0))).toBe("invalid_status");
		expect(expectRejected(withdraw(item, buyerActor("b2"), "o1", T0))).toBe("not_allowed");
	});

	it("[SM-4.4-leave-backup] a backup claim can leave the queue; a claim being decided can't", () => {
		const soldOut = placeAll(makeItem(), [
			["b1", claim("c1")],
			["b2", claim("c2")],
		]);
		const { item } = expectOk(withdraw(soldOut, buyerActor("b2"), "c2", T0));
		expect(item.entries[1]).toMatchObject({ status: "withdrawn", endedReason: "left_backup_queue" });
		const beingDecided = placeAll(makeItem(), [
			["b1", offer("o1", 3000)],
			["b2", claim("c1")],
		]);
		expect(expectRejected(withdraw(beingDecided, buyerActor("b2"), "c1", T0))).toBe("claim_is_binding");
	});
});

const soldWithBackups = (backupAmount: number) =>
	placeAll(makeItem(), [
		["b1", claim("c1")],
		["b2", offer("o1", backupAmount)],
		["b3", claim("c2")],
	]);

describe("removing a winner and promoting", () => {
	it("[SM-4.3-promote-auto] the best backup at or above asking wins after a rescind-and-pass", () => {
		const { item, events } = expectOk(
			sellerRescind(soldWithBackups(4500), ctx, seller(), rescindCommand("c1", true), T0 + HOUR),
		);
		expect(statusOf(item, "c1")).toBe("rescinded");
		expect(statusOf(item, "o1")).toBe("won");
		expect(statusOf(item, "c2")).toBe("open");
		expect(events).toContainEqual(
			expect.objectContaining({ type: "entry_won", entryId: "o1", via: "promotion" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "winner_removed",
				entryId: "c1",
				by: "seller",
				reasonCode: "buyer_nonpayment",
			}),
		);
	});

	it("[SM-4.3-promote-auto] a backup claim at asking ranks above a lower offer", () => {
		const { item } = expectOk(
			sellerRescind(soldWithBackups(3000), ctx, seller(), rescindCommand("c1", true), T0 + HOUR),
		);
		expect(statusOf(item, "c2")).toBe("won");
		expect(statusOf(item, "o1")).toBe("open");
	});

	it("[SM-4.3-promote-below-asking] a best backup below asking restarts the window for the seller", () => {
		const item = placeAll(makeItem(), [
			["b1", claim("c1")],
			["b2", offer("o1", 3000)],
		]);
		const { item: next, events } = expectOk(
			sellerRescind(item, ctx, seller(), rescindCommand("c1", true), T0 + HOUR),
		);
		expect(statusOf(next, "o1")).toBe("open");
		expect(next.decisionDeadline).toBe(T0 + HOUR + 24 * HOUR);
		expect(events).toContainEqual({ type: "seller_notified", reason: "backup_below_asking" });
		expect(deriveItemState(next, "live")).toBe("deciding");
	});

	it("[SM-4.3-promote-auto] with no backups the item is available again (or unsold after close)", () => {
		const item = placeAll(makeItem(), [["b1", claim("c1")]]);
		const { item: next } = expectOk(sellerRescind(item, ctx, seller(), rescindCommand("c1", true), T0));
		expect(deriveItemState(next, "live")).toBe("available");
		expect(deriveItemState(next, "closed")).toBe("unsold");
		expect(promote(makeItem({ withdrawn: true, entries: next.entries }), ctx, T0).events).toEqual([]);
	});

	it("[SM-4.3-rescind-withdraw] a plain rescind withdraws the item and ends its pending entries", () => {
		const { item, events } = expectOk(
			sellerRescind(soldWithBackups(4500), ctx, seller(), rescindCommand("c1", false), T0),
		);
		expect(item.withdrawn).toBe(true);
		expect(item.entries.map((e) => e.status)).toEqual(["rescinded", "ended", "ended"]);
		expect(item.entries[1]).toMatchObject({ endedReason: "item_withdrawn" });
		expect(events).toContainEqual({ type: "item_withdrawn" });
		expect(deriveItemState(item, "live")).toBe("withdrawn");
	});

	it("[SM-4.3-seller-rescind] needs a 20-character explanation, a won entry, and a confirmation after payment", () => {
		const item = soldWithBackups(4500);
		expect(
			expectRejected(
				sellerRescind(item, ctx, seller(), { ...rescindCommand("c1", true), explanation: "too short" }, T0),
			),
		).toBe("explanation_too_short");
		expect(expectRejected(sellerRescind(item, ctx, seller(), rescindCommand("o1", true), T0))).toBe(
			"invalid_status",
		);
		const paid = { ...rescindCommand("c1", true), afterBuyerPaid: true };
		expect(expectRejected(sellerRescind(item, ctx, seller(), paid, T0))).toBe("confirmation_required");
		expectOk(sellerRescind(item, ctx, seller(), { ...paid, confirmed: true }, T0));
		expect(expectRejected(sellerRescind(item, ctx, buyerActor("b1"), rescindCommand("c1", true), T0))).toBe(
			"not_allowed",
		);
		expect(expectRejected(sellerRescind(item, ctx, seller(), rescindCommand("zz", true), T0))).toBe(
			"entry_not_found",
		);
	});

	it("[SM-4.3-pro-rescind] a Pro buyer rescinds until the invoice is sent, five a month, and promotion runs", () => {
		const item = soldWithBackups(4500);
		const pro = buyerActor("b1", "pro");
		const command = { entryId: "c1", invoiceSent: false, rescindsThisMonth: 4 };
		const { item: next, events } = expectOk(buyerRescind(item, ctx, pro, command, T0));
		expect(next.entries[0]).toMatchObject({
			status: "released",
			endedReason: "buyer_rescind",
			endedBy: "b1",
		});
		expect(statusOf(next, "o1")).toBe("won");
		expect(events).toContainEqual(expect.objectContaining({ type: "winner_removed", by: "buyer" }));
		expect(expectRejected(buyerRescind(item, ctx, pro, { ...command, rescindsThisMonth: 5 }, T0))).toBe(
			"rescind_limit_reached",
		);
		expect(expectRejected(buyerRescind(item, ctx, pro, { ...command, invoiceSent: true }, T0))).toBe(
			"invoice_sent",
		);
		expect(expectRejected(buyerRescind(item, ctx, buyerActor("b1"), command, T0))).toBe("pro_only");
		expect(expectRejected(buyerRescind(item, ctx, buyerActor("b2", "pro"), command, T0))).toBe("not_allowed");
		expect(
			expectRejected(buyerRescind(item, ctx, buyerActor("b2", "pro"), { ...command, entryId: "o1" }, T0)),
		).toBe("invalid_status");
	});

	it("[SM-5-takeback-decide] an approved take-back releases the win and promotes", () => {
		const { item, events } = expectOk(releaseForTakeback(soldWithBackups(4500), ctx, seller(), "c1", T0));
		expect(item.entries[0]).toMatchObject({ status: "released", endedReason: "takeback" });
		expect(statusOf(item, "o1")).toBe("won");
		expect(events).toContainEqual(expect.objectContaining({ type: "winner_removed", by: "takeback" }));
		expect(expectRejected(releaseForTakeback(item, ctx, seller(), "c1", T0))).toBe("invalid_status");
		expect(expectRejected(releaseForTakeback(item, ctx, buyerActor("b1"), "o1", T0))).toBe("not_allowed");
	});

	it("the seller withdraws an item: pending entries end, winners stay", () => {
		const item = placeAll(makeItem({ quantity: 2 }), [
			["b1", claim("c1")],
			["b2", offer("o1", 100)],
		]);
		const { item: next } = expectOk(withdrawItem(item, ctx, seller(), T0));
		expect(next.entries.map((e) => e.status)).toEqual(["won", "ended"]);
		expect(expectRejected(withdrawItem(next, ctx, seller(), T0))).toBe("item_withdrawn");
		expect(expectRejected(withdrawItem(item, ctx, buyerActor("b1"), T0))).toBe("not_allowed");
	});
});

describe("after the sale closes", () => {
	const closed = makeContext({ saleStatus: "closed" });

	it("[SM-2-close] an open claim with a free unit gets a decision window at close", () => {
		const item = makeItem({ entries: [makeEntry({ id: "c1", buyerId: "b1" })] });
		const { item: next } = closeItem(item, closed, T0);
		expect(next.decisionDeadline).toBe(T0 + 24 * HOUR);
		expect(closeItem(next, closed, T0 + 1).item.decisionDeadline).toBe(T0 + 24 * HOUR);
	});

	it("[SM-4.5-close-offers-lapse] pending offers on items with free units lapse after one window", () => {
		const item = placeAll(makeItem(), [["b1", offer("o1", 3000)]]);
		const { item: closedItem, events } = closeItem(item, closed, T0);
		expect(closedItem.offersLapseAt).toBe(T0 + 24 * HOUR);
		expect(events).toEqual([{ type: "offers_lapse_set", at: T0 + 24 * HOUR }]);
		expect(expectRejected(lapseOffersAfterClose(closedItem, T0))).toBe("not_due");
		const { item: lapsed } = expectOk(lapseOffersAfterClose(closedItem, T0 + 24 * HOUR));
		expect(lapsed.entries[0]).toMatchObject({ status: "lost", endedReason: "offer_lapsed" });
		expect(lapsed.offersLapseAt).toBeNull();
		expect(deriveItemState(lapsed, "closed")).toBe("unsold");
	});

	it("[SM-4.5-close-offers-lapse] backup offers on sold-out items don't lapse", () => {
		const item = placeAll(makeItem(), [
			["b1", claim("c1")],
			["b2", offer("o1", 3000)],
		]);
		expect(closeItem(item, closed, T0).item.offersLapseAt).toBeNull();
		const { item: next } = expectOk(lapseOffersAfterClose({ ...item, offersLapseAt: T0 }, T0));
		expect(statusOf(next, "o1")).toBe("open");
	});

	it("[SM-4.5-close-unsold] an item with no entries is unsold once the sale closes", () => {
		expect(deriveItemState(makeItem(), "live")).toBe("available");
		expect(closeItem(makeItem(), closed, T0).events).toEqual([]);
		expect(deriveItemState(makeItem(), "closed")).toBe("unsold");
		expect(deriveItemState(makeItem(), "archived")).toBe("unsold");
	});

	it("[SM-4.5-backups-lost] backups are lost once every unit is paid and the sale is closed", () => {
		const item = placeAll(makeItem(), [
			["b1", claim("c1")],
			["b2", claim("c2")],
		]);
		expect(loseBackups(item, "live", 1, T0).events).toEqual([]);
		expect(loseBackups(item, "closed", 0, T0).events).toEqual([]);
		const { item: next } = loseBackups(item, "closed", 1, T0);
		expect(next.entries[1]).toMatchObject({ status: "lost", endedReason: "units_paid", endedBy: "system" });
	});
});

describe("derived state and completion", () => {
	it("[SM-3-derived-state] covers all five states", () => {
		const live = "live";
		expect(deriveItemState(makeItem(), live)).toBe("available");
		expect(deriveItemState(makeItem({ decisionDeadline: T0 }), live)).toBe("deciding");
		expect(
			deriveItemState(makeItem({ entries: [makeEntry({ id: "c", buyerId: "b", status: "won" })] }), live),
		).toBe("sold_out");
		expect(deriveItemState(makeItem({ withdrawn: true }), live)).toBe("withdrawn");
		expect(deriveItemState(makeItem(), "closed")).toBe("unsold");
		const fulfilled = makeItem({ entries: [makeEntry({ id: "c", buyerId: "b", status: "fulfilled" })] });
		expect(freeUnits(fulfilled)).toBe(0);
	});

	it("fulfils won entries when their invoice completes", () => {
		const item = placeAll(makeItem({ quantity: 2 }), [
			["b1", claim("c1")],
			["b2", claim("c2")],
		]);
		const { item: next } = fulfill(item, new Set(["c1"]), T0);
		expect(next.entries.map((e) => e.status)).toEqual(["fulfilled", "won"]);
		expect(freeUnits(next)).toBe(0);
	});
});
