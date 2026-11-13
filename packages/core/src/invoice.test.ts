import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "./common.ts";
import {
	addWin,
	availableShipping,
	complete,
	confirmPaid,
	markBuyerPaid,
	markOverdue,
	paymentNotReceived,
	removeLine,
	send,
	ship,
	subtotal,
	total,
	trackingRequired,
	type Invoice,
} from "./invoice.ts";
import {
	buyerActor,
	expectOk,
	expectRejected,
	makeInvoice,
	seller,
	SELLER,
	SHIPPING_MENU,
	system,
	T0,
} from "./testing.ts";

const line = (entryId: string, amountCents: number) => ({
	entryId,
	description: `Card ${entryId}`,
	amountCents,
});
const buyer = buyerActor("buyer_1");
const draftWith = (...amounts: number[]): Invoice =>
	makeInvoice({ lines: amounts.map((a, i) => ({ ...line(`e${i}`, a), refundOwed: false })) });
const sent = (...amounts: number[]) =>
	expectOk(send(draftWith(...amounts), seller(), "closed", 48 * HOUR, T0)).invoice;
const paidUp = (...amounts: number[]) => {
	const marked = expectOk(
		markBuyerPaid(sent(...amounts), buyer, SHIPPING_MENU, "ground", "ref-1", T0 + HOUR),
	).invoice;
	return expectOk(confirmPaid(marked, seller())).invoice;
};

describe("adding wins", () => {
	it("[SM-6-late-wins-new-invoice] wins go into the buyer's draft, or a new draft once the first was sent", () => {
		const first = expectOk(addWin([], "buyer_1", SELLER, "free", line("e1", 1000), "inv_1"));
		expect(first.events).toEqual([
			{ type: "invoice_created", invoiceId: "inv_1" },
			{ type: "line_added", invoiceId: "inv_1", entryId: "e1" },
		]);
		const second = expectOk(addWin([first.invoice], "buyer_1", SELLER, "free", line("e2", 500), "inv_x"));
		expect(second.invoice.id).toBe("inv_1");
		expect(subtotal(second.invoice)).toBe(1500);
		const wasSent = expectOk(send(second.invoice, seller(), "closed", 48 * HOUR, T0)).invoice;
		const late = expectOk(addWin([wasSent], "buyer_1", SELLER, "free", line("e3", 700), "inv_2"));
		expect(late.invoice).toMatchObject({ id: "inv_2", status: "draft" });
		expect(expectRejected(addWin([wasSent], "buyer_1", SELLER, "free", line("e1", 1000), "inv_3"))).toBe(
			"duplicate_line",
		);
	});
});

const ids = (subtotalCents: number, tier: "free" | "pro") =>
	availableShipping(SHIPPING_MENU, subtotalCents, tier).map((o) => o.id);

describe("sending and paying", () => {
	it("[SM-6-send-after-close] invoices are sent only after the sale closes, by the seller or auto-send", () => {
		for (const status of ["draft", "scheduled", "live"] as const) {
			expect(expectRejected(send(draftWith(1000), seller(), status, 48 * HOUR, T0))).toBe("sale_not_closed");
		}
		const { invoice, events } = expectOk(send(draftWith(1000), system, "closed", 48 * HOUR, T0));
		expect(invoice).toMatchObject({ status: "sent", sentAt: T0, dueAt: T0 + 48 * HOUR });
		expect(events).toEqual([{ type: "invoice_sent", dueAt: T0 + 48 * HOUR }]);
		expect(expectRejected(send(draftWith(1000), buyer, "closed", 48 * HOUR, T0))).toBe("not_allowed");
		expect(expectRejected(send(draftWith(), seller(), "closed", 48 * HOUR, T0))).toBe("invalid_status");
	});

	it("[SM-6-payment-deadline] past the deadline the invoice is overdue; auto-rescind is opt-in", () => {
		const invoice = sent(1000, 2000);
		expect(expectRejected(markOverdue(invoice, false, T0 + HOUR))).toBe("not_due");
		expect(expectOk(markOverdue(invoice, false, T0 + 48 * HOUR)).events).toEqual([
			{ type: "invoice_overdue" },
		]);
		const auto = expectOk(markOverdue(invoice, true, T0 + 48 * HOUR));
		expect(auto.invoice.status).toBe("overdue");
		expect(auto.events).toContainEqual({ type: "auto_rescind_requested", entryIds: ["e0", "e1"] });
	});

	it("[SM-6-shipping-threshold] untracked shipping is hidden above $20 for free sellers and $40 for Pro", () => {
		expect(ids(2000, "free")).toEqual(["pwe", "ground"]);
		expect(ids(2001, "free")).toEqual(["ground"]);
		expect(ids(4000, "pro")).toEqual(["pwe", "ground"]);
		expect(ids(4001, "pro")).toEqual(["ground"]);
		expect(expectRejected(markBuyerPaid(sent(2500), buyer, SHIPPING_MENU, "pwe", null, T0))).toBe(
			"unknown_shipping_option",
		);
	});

	it("[SM-6-paid-flow] buyer_paid → paid → shipped → completed, with late payment allowed", () => {
		const overdue = expectOk(markOverdue(sent(1500), false, T0 + 48 * HOUR)).invoice;
		const marked = expectOk(markBuyerPaid(overdue, buyer, SHIPPING_MENU, "pwe", "pp-123", T0 + 50 * HOUR));
		expect(marked.invoice).toMatchObject({ status: "buyer_paid", shippingCents: 100, paymentRef: "pp-123" });
		expect(total(marked.invoice)).toBe(1600);
		const confirmed = expectOk(confirmPaid(marked.invoice, seller())).invoice;
		const shipped = expectOk(ship(confirmed, seller(), null, T0 + 3 * DAY)).invoice;
		expect(shipped).toMatchObject({ status: "shipped", tracking: null });
		expect(expectOk(complete(shipped, buyer, T0 + 4 * DAY)).invoice.status).toBe("completed");
	});

	it("[SM-6-paid-flow] tracking is required to ship above the threshold", () => {
		const invoice = paidUp(2500);
		expect(trackingRequired(invoice)).toBe(true);
		expect(expectRejected(ship(invoice, seller(), null, T0))).toBe("tracking_required");
		expect(expectRejected(ship(invoice, seller(), { carrier: "USPS", number: " " }, T0))).toBe(
			"tracking_required",
		);
		const shipped = expectOk(ship(invoice, seller(), { carrier: "USPS", number: "9400" }, T0)).invoice;
		expect(shipped.tracking).toEqual({ carrier: "USPS", number: "9400" });
	});

	it("[SM-6-paid-flow] the seller can say a payment didn't arrive; the deadline doesn't restart", () => {
		const marked = expectOk(markBuyerPaid(sent(1000), buyer, SHIPPING_MENU, "pwe", null, T0 + HOUR)).invoice;
		const back = expectOk(paymentNotReceived(marked, seller())).invoice;
		expect(back).toMatchObject({ status: "sent", dueAt: T0 + 48 * HOUR, paidAt: null });
		expect(expectRejected(paymentNotReceived(back, seller()))).toBe("invalid_status");
		expect(expectRejected(paymentNotReceived(marked, buyer))).toBe("not_allowed");
	});

	it("[SM-6-paid-flow] each step is for the right party, in order", () => {
		expect(expectRejected(markBuyerPaid(sent(1000), seller(), SHIPPING_MENU, "pwe", null, T0))).toBe(
			"not_allowed",
		);
		expect(expectRejected(markBuyerPaid(draftWith(1000), buyer, SHIPPING_MENU, "pwe", null, T0))).toBe(
			"invalid_status",
		);
		expect(expectRejected(confirmPaid(sent(1000), seller()))).toBe("invalid_status");
		expect(expectRejected(ship(sent(1000), seller(), null, T0))).toBe("invalid_status");
		expect(expectRejected(ship(paidUp(1000), buyer, null, T0))).toBe("not_allowed");
		expect(expectRejected(complete(paidUp(1000), buyer, T0))).toBe("invalid_status");
	});

	it("[SM-6-gmv] gmv_cents is recorded when the invoice becomes paid", () => {
		const marked = expectOk(markBuyerPaid(sent(1000, 500), buyer, SHIPPING_MENU, "ground", null, T0)).invoice;
		expect(marked.gmvCents).toBeNull();
		const { invoice, events } = expectOk(confirmPaid(marked, seller()));
		expect(invoice.gmvCents).toBe(2050);
		expect(events).toEqual([{ type: "payment_confirmed", gmvCents: 2050 }]);
		expect(expectRejected(confirmPaid(marked, buyer))).toBe("not_allowed");
	});

	it("[SM-6-autocomplete] completes 14 days after shipping, and feedback opens", () => {
		const shipped = expectOk(ship(paidUp(1000), seller(), null, T0)).invoice;
		expect(expectRejected(complete(shipped, system, T0 + 13 * DAY))).toBe("not_due");
		const { events } = expectOk(complete(shipped, system, T0 + 14 * DAY));
		expect(events).toEqual([{ type: "invoice_completed", by: "auto" }, { type: "feedback_opened" }]);
		expect(expectRejected(complete(shipped, seller(), T0 + 20 * DAY))).toBe("not_allowed");
	});
});

describe("rescinded lines", () => {
	it("[SM-6-rescind-line] before payment the line is removed and the total recalculated", () => {
		const invoice = sent(1000, 2500);
		const { invoice: next, events } = expectOk(removeLine(invoice, "e1", true));
		expect(next.lines.map((l) => l.entryId)).toEqual(["e0"]);
		expect(total(next)).toBe(1000);
		expect(events).toEqual([{ type: "line_removed", entryId: "e1" }]);
	});

	it("[SM-6-rescind-line] removing the last line cancels the invoice", () => {
		const { invoice, events } = expectOk(removeLine(draftWith(1000), "e0", false));
		expect(invoice.status).toBe("cancelled");
		expect(events).toContainEqual({ type: "invoice_cancelled" });
	});

	it("[SM-6-rescind-line] after payment the line stays, marked refund owed (unless none is due)", () => {
		const invoice = paidUp(1000, 2500);
		const { invoice: next, events } = expectOk(removeLine(invoice, "e1", true));
		expect(next.lines[1]).toMatchObject({ entryId: "e1", refundOwed: true });
		expect(events).toEqual([{ type: "line_refund_owed", entryId: "e1" }]);
		expect(expectOk(removeLine(invoice, "e1", false)).events).toEqual([]);
		expect(expectRejected(removeLine(invoice, "zz", true))).toBe("line_not_found");
		const shipped = expectOk(ship(paidUp(1000), seller(), null, T0)).invoice;
		expect(expectRejected(removeLine(shipped, "e0", true))).toBe("invalid_status");
	});

	it("the total is never negative", () => {
		expect(
			total(makeInvoice({ lines: [{ ...line("e", 500), refundOwed: false }], adjustmentCents: -900 })),
		).toBe(0);
	});
});
