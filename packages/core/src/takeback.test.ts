import { describe, expect, it } from "vitest";
import { HOUR } from "./common.ts";
import { cancelTakeback, decideTakeback, requestTakeback, type RequestTakebackInput } from "./takeback.ts";
import { buyerActor, expectOk, expectRejected, seller, SELLER, system, T0 } from "./testing.ts";

const input = (overrides: Partial<RequestTakebackInput> = {}): RequestTakebackInput => ({
	requestId: "tb_1",
	entryId: "e1",
	entryBuyerId: "b1",
	entryWon: true,
	invoiceStatus: "draft",
	previous: [],
	...overrides,
});

describe("take-back requests", () => {
	it("[SM-5-takeback-request] the winner files one pending request while the invoice is unpaid", () => {
		const request = expectOk(requestTakeback(buyerActor("b1"), input(), T0));
		expect(request).toMatchObject({ status: "pending", entryId: "e1", buyerId: "b1" });
		for (const invoiceStatus of ["none", "draft", "sent", "overdue"] as const) {
			expectOk(requestTakeback(buyerActor("b1"), input({ invoiceStatus }), T0));
		}
		expect(expectRejected(requestTakeback(buyerActor("b1"), input({ previous: [request] }), T0))).toBe(
			"already_pending",
		);
	});

	it("[SM-5-takeback-request] not after the buyer marked the invoice paid, and only for the winner of a won entry", () => {
		for (const invoiceStatus of ["buyer_paid", "paid", "shipped", "completed"] as const) {
			expect(expectRejected(requestTakeback(buyerActor("b1"), input({ invoiceStatus }), T0))).toBe(
				"invoice_paid",
			);
		}
		expect(expectRejected(requestTakeback(buyerActor("b2"), input(), T0))).toBe("not_allowed");
		expect(expectRejected(requestTakeback(seller(), input(), T0))).toBe("not_allowed");
		expect(expectRejected(requestTakeback(buyerActor("b1"), input({ entryWon: false }), T0))).toBe("not_won");
	});

	it("[SM-5-takeback-decide] the seller approves or denies; after a denial the buyer can't file again", () => {
		const request = expectOk(requestTakeback(buyerActor("b1"), input(), T0));
		expect(expectRejected(decideTakeback(request, buyerActor("b1"), SELLER, true, T0))).toBe("not_allowed");
		const approved = expectOk(decideTakeback(request, seller(), SELLER, true, T0 + HOUR));
		expect(approved).toMatchObject({ status: "approved", decidedAt: T0 + HOUR });
		expect(expectRejected(decideTakeback(approved, seller(), SELLER, false, T0))).toBe("invalid_status");
		const denied = expectOk(decideTakeback(request, seller(), SELLER, false, T0 + HOUR));
		expect(expectRejected(requestTakeback(buyerActor("b1"), input({ previous: [denied] }), T0))).toBe(
			"denied_before",
		);
		const cancelled = expectOk(cancelTakeback(request, buyerActor("b1"), T0));
		expectOk(requestTakeback(buyerActor("b1"), input({ previous: [cancelled] }), T0));
	});

	it("the buyer cancels a pending request, or the system does when the entry ends", () => {
		const request = expectOk(requestTakeback(buyerActor("b1"), input(), T0));
		expect(expectOk(cancelTakeback(request, system, T0)).status).toBe("cancelled");
		expect(expectRejected(cancelTakeback(request, seller(), T0))).toBe("not_allowed");
		const approved = expectOk(decideTakeback(request, seller(), SELLER, true, T0));
		expect(expectRejected(cancelTakeback(approved, buyerActor("b1"), T0))).toBe("invalid_status");
	});
});
