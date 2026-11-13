import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "./common.ts";
import { answerMutual, contest, createRescind, recordEffects, resolve, RESCIND_REASONS } from "./rescind.ts";
import { admin, buyerActor, expectOk, expectRejected, seller, T0 } from "./testing.ts";

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
