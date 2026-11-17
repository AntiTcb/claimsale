import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "./common.ts";
import {
	answerMutual,
	buyerRecord,
	contest,
	contestOpenUntil,
	createRescind,
	flagsSeller,
	fromStored,
	isOverturned,
	isRescindReasonCode,
	isResolvedFault,
	mutualAnswerDueAt,
	recordEffects,
	resolve,
	RESCIND_REASON_CODES,
	RESCIND_REASONS,
	validateContestText,
	type Rescind,
	type StoredRescind,
} from "./rescind.ts";
import { pendingTimers } from "./timers.ts";
import { admin, buyerActor, expectOk, expectRejected, makeSale, seller, T0 } from "./testing.ts";

const stored = (overrides: Partial<StoredRescind> = {}): StoredRescind => ({
	reasonCode: "buyer_nonpayment",
	phase: null,
	refundOwed: false,
	createdAt: T0,
	contestedAt: null,
	resolvedFault: null,
	resolvedAt: null,
	...overrides,
});

describe("stored rescinds", () => {
	it("[SM-4.3.1-contest] reads the stored phase, or derives it for rows written before the column", () => {
		expect(fromStored(stored({ phase: "contested", contestedAt: T0 }))?.phase).toBe("contested");
		expect(fromStored(stored())).toMatchObject({ phase: "final", fault: "buyer" });
		expect(fromStored(stored({ contestedAt: T0 + DAY }))?.phase).toBe("contested");
		expect(
			fromStored(stored({ contestedAt: T0, resolvedAt: T0 + DAY, resolvedFault: "seller" })),
		).toMatchObject({
			phase: "final",
			resolvedFault: "seller",
		});
		expect(fromStored(stored({ reasonCode: "suspected_fraud" }))).toMatchObject({
			phase: "admin_review",
			fault: "review",
		});
		expect(fromStored(stored({ reasonCode: "mutual_agreement" }))?.phase).toBe("awaiting_buyer");
		// Unknown phases and faults fall back; unknown reason codes are skipped.
		expect(fromStored(stored({ phase: "bogus", resolvedFault: "review" }))).toMatchObject({
			phase: "final",
			resolvedFault: null,
		});
		expect(fromStored(stored({ reasonCode: "nope" }))).toBeNull();
	});

	it("knows every reason code and the faults an admin can pick", () => {
		expect(RESCIND_REASON_CODES.toSorted()).toEqual(Object.keys(RESCIND_REASONS).toSorted());
		expect(isRescindReasonCode("buyer_nonpayment")).toBe(true);
		expect(isRescindReasonCode("toString")).toBe(false);
		expect(isResolvedFault("neutral")).toBe(true);
		expect(isResolvedFault("review")).toBe(false);
	});
});

describe("contest and answer windows", () => {
	it("[SM-4.3.1-mutual] a mutual agreement is due 72h after the rescind and becomes a sale timer", () => {
		const waiting = createRescind("mutual_agreement", false, T0);
		expect(mutualAnswerDueAt(waiting)).toBe(T0 + 72 * HOUR);
		expect(mutualAnswerDueAt(createRescind("buyer_nonpayment", false, T0))).toBeNull();
		const timers = pendingTimers(
			makeSale({ status: "closed" }),
			[],
			[],
			[
				{ id: "r1", rescind: waiting },
				{ id: "r2", rescind: createRescind("seller_listing_error", false, T0) },
			],
		);
		expect(timers).toEqual([{ kind: "mutual_answer_due", at: T0 + 72 * HOUR, rescindId: "r1" }]);
	});

	it("[SM-4.3.1-contest] the contest stays open for 7 days on a final, uncontested rescind", () => {
		const r = createRescind("buyer_nonpayment", false, T0);
		expect(contestOpenUntil(r, T0 + DAY)).toBe(T0 + 7 * DAY);
		expect(contestOpenUntil(r, T0 + 7 * DAY + 1)).toBeNull();
		expect(contestOpenUntil(createRescind("mutual_agreement", false, T0), T0)).toBeNull();
		const contested = expectOk(contest(r, buyerActor("b1"), "b1", T0));
		expect(contestOpenUntil(contested, T0)).toBeNull();
	});

	it("[SM-4.3.1-contest] the buyer must give their side", () => {
		expect(validateContestText("  short  ")).toMatchObject({
			ok: false,
			error: { code: "contest_text_invalid" },
		});
		expect(validateContestText("x".repeat(2001)).ok).toBe(false);
		expect(validateContestText("  I paid on time, here is the reference.  ")).toEqual({
			ok: true,
			value: "I paid on time, here is the reference.",
		});
	});
});

/** A contested non-payment rescind the admin resolved to `to`. */
function overturned(to: "seller" | "neutral" | "buyer"): Rescind {
	const contested = expectOk(
		contest(createRescind("buyer_nonpayment", false, T0), buyerActor("b1"), "b1", T0),
	);
	return expectOk(resolve(contested, admin, to));
}

describe("abuse guard and records", () => {
	it("[SM-4.3.1-abuse-guard] a contested buyer-fault rescind moved off the buyer is overturned", () => {
		expect(isOverturned(overturned("seller"))).toBe(true);
		expect(isOverturned(overturned("neutral"))).toBe(true);
		expect(isOverturned(overturned("buyer"))).toBe(false);
		// Seller-fault codes and uncontested rescinds never count.
		const sellerFault = expectOk(
			contest(createRescind("seller_listing_error", false, T0), buyerActor("b1"), "b1", T0),
		);
		expect(isOverturned(expectOk(resolve(sellerFault, admin, "neutral")))).toBe(false);
		expect(isOverturned(createRescind("buyer_nonpayment", false, T0))).toBe(false);
	});

	it("[SM-4.3.1-abuse-guard] the third overturned rescind flags the seller", () => {
		expect(flagsSeller(2)).toBe(false);
		expect(flagsSeller(3)).toBe(true);
	});

	it("[REP-buyer-record] counts final marks by resolved fault; held, contested and waiting rescinds count for no one", () => {
		const record = buyerRecord({
			rescinds: [
				createRescind("buyer_nonpayment", false, T0),
				createRescind("buyer_unresponsive", false, T0),
				createRescind("buyer_payment_reversed", true, T0),
				createRescind("buyer_requested_after_payment", true, T0),
				createRescind("buyer_terms_violation", false, T0),
				createRescind("seller_item_unavailable", false, T0),
				createRescind("mutual_agreement", false, T0),
				createRescind("suspected_fraud", false, T0),
				expectOk(contest(createRescind("buyer_nonpayment", false, T0), buyerActor("b1"), "b1", T0)),
				overturned("seller"),
				overturned("buyer"),
			],
			completedPurchases: 12,
			approvedTakebacks: 2,
			proRescinds: 1,
			memberSince: T0 - 400 * DAY,
		});
		expect(record).toEqual({
			completedPurchases: 12,
			nonPay: 3,
			paymentReversed: 1,
			takebacks: 3,
			violations: 1,
			proRescinds: 1,
			memberSince: T0 - 400 * DAY,
		});
	});
});

const final = (code: Parameters<typeof createRescind>[0], afterBuyerPaid = false) =>
	createRescind(code, afterBuyerPaid, T0);

describe("rescind attribution", () => {
	it("[SM-4.3.1-buyer-nonpayment] non-payment and unresponsive count as non_pay on the buyer only", () => {
		for (const code of ["buyer_nonpayment", "buyer_unresponsive"] as const) {
			expect(final(code)).toMatchObject({ fault: "buyer", phase: "final" });
			expect(recordEffects(final(code))).toEqual({ buyer: "non_pay", seller: null });
		}
	});

	it("[SM-4.3.1-buyer-payment-reversed] a reversed payment is a severe buyer mark and owes no refund", () => {
		const r = final("buyer_payment_reversed", true);
		expect(recordEffects(r)).toEqual({ buyer: "payment_reversed", seller: null });
		expect(r.refundOwed).toBe(false);
	});

	it("[SM-4.3.1-buyer-requested-after-payment] counts as a take-back for the buyer; the seller is unaffected", () => {
		expect(recordEffects(final("buyer_requested_after_payment"))).toEqual({
			buyer: "takeback",
			seller: null,
		});
	});

	it("[SM-4.3.1-buyer-terms-violation] counts as a violation for the buyer", () => {
		expect(recordEffects(final("buyer_terms_violation"))).toEqual({ buyer: "violation", seller: null });
	});

	it("[SM-4.3.1-seller-fault] item unavailable and listing errors count as seller_cancel only", () => {
		for (const code of ["seller_item_unavailable", "seller_listing_error"] as const) {
			expect(recordEffects(final(code))).toEqual({ buyer: null, seller: "seller_cancel" });
		}
	});

	it("[SM-4.3.1-refund-owed] a refund is owed after buyer_paid, except when the payment was reversed", () => {
		expect(final("seller_item_unavailable", true).refundOwed).toBe(true);
		expect(final("buyer_requested_after_payment", true).refundOwed).toBe(true);
		expect(final("seller_item_unavailable", false).refundOwed).toBe(false);
		expect(final("buyer_payment_reversed", true).refundOwed).toBe(false);
	});

	it("every reason code has an attribution", () => {
		expect(Object.keys(RESCIND_REASONS)).toHaveLength(9);
	});
});

const mutual = () => final("mutual_agreement");

describe("mutual agreement", () => {
	it("[SM-4.3.1-mutual] waits for the buyer; nothing counts meanwhile", () => {
		expect(mutual().phase).toBe("awaiting_buyer");
		expect(recordEffects(mutual())).toEqual({ buyer: null, seller: null });
	});

	it("[SM-4.3.1-mutual] agreeing, or 72h without an answer, makes it neutral", () => {
		const agreed = expectOk(answerMutual(mutual(), buyerActor("b1"), "b1", "agree", T0 + HOUR));
		expect(agreed.phase).toBe("final");
		expect(recordEffects(agreed)).toEqual({ buyer: null, seller: null });
		expect(expectRejected(answerMutual(mutual(), { kind: "system" }, "b1", "timeout", T0 + 71 * HOUR))).toBe(
			"not_due",
		);
		expect(expectOk(answerMutual(mutual(), { kind: "system" }, "b1", "timeout", T0 + 72 * HOUR)).phase).toBe(
			"final",
		);
	});

	it("[SM-4.3.1-mutual] disputing sends it to the admin; only the buyer answers", () => {
		const disputed = expectOk(answerMutual(mutual(), buyerActor("b1"), "b1", "dispute", T0));
		expect(disputed.phase).toBe("contested");
		expect(expectRejected(answerMutual(mutual(), buyerActor("b2"), "b1", "agree", T0))).toBe("not_allowed");
		expect(expectRejected(answerMutual(disputed, buyerActor("b1"), "b1", "agree", T0))).toBe("invalid_phase");
	});
});

describe("review and contests", () => {
	it("[SM-4.3.1-fraud-review] suspected fraud holds both records until the admin resolves it", () => {
		const held = final("suspected_fraud");
		expect(held).toMatchObject({ fault: "review", phase: "admin_review" });
		expect(recordEffects(held)).toEqual({ buyer: null, seller: null });
		expect(expectRejected(resolve(held, seller(), "buyer"))).toBe("not_allowed");
		expect(expectRejected(resolve(held, admin, "review"))).toBe("invalid_phase");
		const resolved = expectOk(resolve(held, admin, "buyer"));
		expect(recordEffects(resolved)).toEqual({ buyer: "violation", seller: null });
	});

	it("[SM-4.3.1-contest] a contest within 7 days freezes the attribution until the admin resolves it", () => {
		const r = final("buyer_nonpayment");
		expect(expectRejected(contest(r, buyerActor("b1"), "b1", T0 + 7 * DAY + 1))).toBe(
			"contest_window_closed",
		);
		expect(expectRejected(contest(r, buyerActor("b2"), "b1", T0))).toBe("not_allowed");
		const contested = expectOk(contest(r, buyerActor("b1"), "b1", T0 + DAY));
		expect(recordEffects(contested)).toEqual({ buyer: null, seller: null });
		expect(expectRejected(contest(contested, buyerActor("b1"), "b1", T0 + DAY))).toBe("invalid_phase");
		const flipped = expectOk(resolve(contested, admin, "seller"));
		expect(recordEffects(flipped)).toEqual({ buyer: null, seller: "seller_cancel" });
		expect(expectRejected(resolve(flipped, admin, "neutral"))).toBe("invalid_phase");
		expect(recordEffects(expectOk(resolve(contested, admin, "neutral")))).toEqual({
			buyer: null,
			seller: null,
		});
	});

	it("[SM-4.3.1-contest] an upheld contest keeps the original attribution", () => {
		const contested = expectOk(contest(final("buyer_nonpayment"), buyerActor("b1"), "b1", T0));
		expect(recordEffects(expectOk(resolve(contested, admin, "buyer")))).toEqual({
			buyer: "non_pay",
			seller: null,
		});
	});
});
