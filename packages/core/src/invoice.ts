import {
	assertCents,
	ok,
	reject,
	type Actor,
	type Millis,
	type Rejection,
	type Result,
	type Tier,
	type UserId,
} from "./common.ts";
import type { Cents } from "./money.ts";
import { AUTOCOMPLETE_AFTER, TRACKING_THRESHOLD } from "./plans.ts";
import type { SaleStatus } from "./sale.ts";

/** Invoices (STATE_MACHINES §6): one buyer's wins in one sale. */

export type InvoiceStatus =
	| "draft"
	| "sent"
	| "overdue"
	| "buyer_paid"
	| "paid"
	| "shipped"
	| "completed"
	| "cancelled";

export interface InvoiceLine {
	readonly entryId: string;
	readonly description: string;
	readonly amountCents: Cents;
	readonly refundOwed: boolean;
}

export interface ShippingOption {
	readonly id: string;
	readonly label: string;
	readonly priceCents: Cents;
	readonly tracked: boolean;
}

export interface Invoice {
	readonly id: string;
	readonly buyerId: UserId;
	readonly sellerId: UserId;
	readonly sellerTier: Tier;
	readonly status: InvoiceStatus;
	readonly lines: readonly InvoiceLine[];
	readonly shippingCents: Cents;
	/** Seller adjustments (discounts are negative); the total never goes below zero. */
	readonly adjustmentCents: number;
	readonly shippingOptionId: string | null;
	readonly paymentRef: string | null;
	readonly tracking: { readonly carrier: string; readonly number: string } | null;
	readonly sentAt: Millis | null;
	readonly dueAt: Millis | null;
	readonly paidAt: Millis | null;
	readonly shippedAt: Millis | null;
	readonly completedAt: Millis | null;
	/** Recorded when the invoice becomes `paid` (feeds the fee ledger). */
	readonly gmvCents: Cents | null;
}

export type InvoiceEvent =
	| { readonly type: "invoice_created"; readonly invoiceId: string }
	| { readonly type: "line_added"; readonly invoiceId: string; readonly entryId: string }
	| { readonly type: "invoice_sent"; readonly dueAt: Millis }
	| { readonly type: "invoice_overdue" }
	| { readonly type: "auto_rescind_requested"; readonly entryIds: readonly string[] }
	| { readonly type: "buyer_marked_paid" }
	| { readonly type: "payment_confirmed"; readonly gmvCents: Cents }
	| { readonly type: "payment_not_received" }
	| { readonly type: "invoice_shipped" }
	| { readonly type: "invoice_completed"; readonly by: "buyer" | "auto" }
	| { readonly type: "feedback_opened" }
	| { readonly type: "line_removed"; readonly entryId: string }
	| { readonly type: "line_refund_owed"; readonly entryId: string }
	| { readonly type: "invoice_cancelled" };

export type InvoiceRejection = Rejection<
	| "not_allowed"
	| "invalid_status"
	| "sale_not_closed"
	| "unknown_shipping_option"
	| "tracking_required"
	| "not_due"
	| "line_not_found"
	| "duplicate_line"
>;

export interface InvoiceTransition {
	readonly invoice: Invoice;
	readonly events: readonly InvoiceEvent[];
}

type InvoiceResult = Result<InvoiceTransition, InvoiceRejection>;

const done = (invoice: Invoice, events: InvoiceEvent[]): InvoiceResult => ok({ invoice, events });

/** Lines that still count toward the total (refund-owed lines were taken back after payment). */
export function subtotal(invoice: Invoice): Cents {
	return invoice.lines.reduce((sum, line) => (line.refundOwed ? sum : sum + line.amountCents), 0);
}

/** Subtotal + shipping + adjustments, never below zero. */
export function total(invoice: Invoice): Cents {
	return Math.max(0, subtotal(invoice) + invoice.shippingCents + invoice.adjustmentCents);
}

/**
 * The shipping options a buyer can pick.
 *
 * @spec SM-6-shipping-threshold — untracked options are hidden above $20 (free sellers) or $40 (Pro).
 */
export function availableShipping(
	menu: readonly ShippingOption[],
	subtotalCents: Cents,
	sellerTier: Tier,
): ShippingOption[] {
	return menu.filter((option) => option.tracked || subtotalCents <= TRACKING_THRESHOLD[sellerTier]);
}

/** Whether shipping this invoice needs a tracking number (D15). */
export function trackingRequired(invoice: Invoice): boolean {
	return subtotal(invoice) > TRACKING_THRESHOLD[invoice.sellerTier];
}

export function newInvoice(id: string, buyerId: UserId, sellerId: UserId, sellerTier: Tier): Invoice {
	return {
		id,
		buyerId,
		sellerId,
		sellerTier,
		status: "draft",
		lines: [],
		shippingCents: 0,
		adjustmentCents: 0,
		shippingOptionId: null,
		paymentRef: null,
		tracking: null,
		sentAt: null,
		dueAt: null,
		paidAt: null,
		shippedAt: null,
		completedAt: null,
		gmvCents: null,
	};
}

/**
 * Adds a won entry to the buyer's draft invoice for the sale, creating a new draft
 * if there is none (for example after the first one was sent).
 *
 * @spec SM-6-late-wins-new-invoice
 */
export function addWin(
	invoices: readonly Invoice[],
	buyerId: UserId,
	sellerId: UserId,
	sellerTier: Tier,
	line: Omit<InvoiceLine, "refundOwed">,
	newInvoiceId: string,
): Result<{ readonly invoice: Invoice; readonly events: readonly InvoiceEvent[] }, InvoiceRejection> {
	assertCents(line.amountCents, "amountCents");
	if (invoices.some((inv) => inv.lines.some((l) => l.entryId === line.entryId))) {
		return reject("duplicate_line", "This win is already on an invoice");
	}
	const draft = invoices.find((inv) => inv.buyerId === buyerId && inv.status === "draft");
	const events: InvoiceEvent[] = [];
	const base = draft ?? newInvoice(newInvoiceId, buyerId, sellerId, sellerTier);
	if (!draft) events.push({ type: "invoice_created", invoiceId: base.id });
	events.push({ type: "line_added", invoiceId: base.id, entryId: line.entryId });
	return ok({ invoice: { ...base, lines: [...base.lines, { ...line, refundOwed: false }] }, events });
}

const isSeller = (invoice: Invoice, actor: Actor) => actor.kind === "seller" && actor.id === invoice.sellerId;
const isBuyer = (invoice: Invoice, actor: Actor) => actor.kind === "buyer" && actor.id === invoice.buyerId;

/**
 * Sends a draft (the seller, or auto-send at close).
 *
 * @spec SM-6-send-after-close — never before the sale closes (D49).
 * @spec SM-6-payment-deadline — due after the seller's payment deadline.
 */
export function send(
	invoice: Invoice,
	actor: Actor,
	saleStatus: SaleStatus,
	paymentDeadlineMs: Millis,
	now: Millis,
): InvoiceResult {
	if (!isSeller(invoice, actor) && actor.kind !== "system")
		return reject("not_allowed", "Only the seller sends invoices");
	if (invoice.status !== "draft" || invoice.lines.length === 0)
		return reject("invalid_status", "Only a draft with lines can be sent");
	if (saleStatus !== "closed" && saleStatus !== "archived") {
		return reject("sale_not_closed", "Invoices go out after the sale closes");
	}
	const dueAt = now + paymentDeadlineMs;
	return done({ ...invoice, status: "sent", sentAt: now, dueAt }, [{ type: "invoice_sent", dueAt }]);
}

/**
 * The payment deadline passed (DO alarm).
 *
 * @spec SM-6-payment-deadline — → `overdue`; with auto-rescind on (D13), every line is rescinded and passed on.
 */
export function markOverdue(invoice: Invoice, autoRescind: boolean, now: Millis): InvoiceResult {
	if (invoice.status !== "sent" || invoice.dueAt === null || now < invoice.dueAt) {
		return reject("not_due", "The invoice isn't overdue");
	}
	const events: InvoiceEvent[] = [{ type: "invoice_overdue" }];
	if (autoRescind)
		events.push({ type: "auto_rescind_requested", entryIds: invoice.lines.map((l) => l.entryId) });
	return done({ ...invoice, status: "overdue" }, events);
}

/**
 * The buyer picks shipping and marks the invoice paid (late payment is allowed).
 *
 * @spec SM-6-paid-flow
 * @spec SM-6-shipping-threshold
 */
export function markBuyerPaid(
	invoice: Invoice,
	actor: Actor,
	menu: readonly ShippingOption[],
	shippingOptionId: string,
	paymentRef: string | null,
	now: Millis,
): InvoiceResult {
	if (!isBuyer(invoice, actor)) return reject("not_allowed", "Only the buyer can mark this paid");
	if (invoice.status !== "sent" && invoice.status !== "overdue")
		return reject("invalid_status", "This invoice isn't awaiting payment");
	const option = availableShipping(menu, subtotal(invoice), invoice.sellerTier).find(
		(o) => o.id === shippingOptionId,
	);
	if (!option) return reject("unknown_shipping_option", "Pick one of the shipping options shown");
	return done(
		{
			...invoice,
			status: "buyer_paid",
			shippingOptionId,
			shippingCents: option.priceCents,
			paymentRef,
			paidAt: now,
		},
		[{ type: "buyer_marked_paid" }],
	);
}

/**
 * The seller confirms the payment arrived.
 *
 * @spec SM-6-paid-flow
 * @spec SM-6-gmv — `gmv_cents` is recorded now.
 */
export function confirmPaid(invoice: Invoice, actor: Actor): InvoiceResult {
	if (!isSeller(invoice, actor)) return reject("not_allowed", "Only the seller confirms payment");
	if (invoice.status !== "buyer_paid") return reject("invalid_status", "The buyer hasn't marked this paid");
	const gmvCents = total(invoice);
	return done({ ...invoice, status: "paid", gmvCents }, [{ type: "payment_confirmed", gmvCents }]);
}

/** The seller says the payment didn't arrive; the deadline does not restart. */
export function paymentNotReceived(invoice: Invoice, actor: Actor): InvoiceResult {
	if (!isSeller(invoice, actor)) return reject("not_allowed", "Only the seller can say that");
	if (invoice.status !== "buyer_paid") return reject("invalid_status", "The buyer hasn't marked this paid");
	return done({ ...invoice, status: "sent", paidAt: null }, [{ type: "payment_not_received" }]);
}

/**
 * The seller ships.
 *
 * @spec SM-6-paid-flow — tracking is required above the seller's threshold (D15).
 */
export function ship(
	invoice: Invoice,
	actor: Actor,
	tracking: { readonly carrier: string; readonly number: string } | null,
	now: Millis,
): InvoiceResult {
	if (!isSeller(invoice, actor)) return reject("not_allowed", "Only the seller ships");
	if (invoice.status !== "paid") return reject("invalid_status", "Confirm the payment first");
	const hasTracking = tracking !== null && tracking.carrier.trim() !== "" && tracking.number.trim() !== "";
	if (trackingRequired(invoice) && !hasTracking) {
		return reject("tracking_required", "This order needs a tracking number");
	}
	return done({ ...invoice, status: "shipped", tracking: hasTracking ? tracking : null, shippedAt: now }, [
		{ type: "invoice_shipped" },
	]);
}

/**
 * The buyer confirms receipt, or 14 days pass after shipping.
 *
 * @spec SM-6-autocomplete — feedback opens on completion (D50).
 */
export function complete(invoice: Invoice, actor: Actor, now: Millis): InvoiceResult {
	if (invoice.status !== "shipped" || invoice.shippedAt === null)
		return reject("invalid_status", "The order hasn't shipped");
	let by: "buyer" | "auto";
	if (isBuyer(invoice, actor)) by = "buyer";
	else if (actor.kind === "system") {
		if (now - invoice.shippedAt < AUTOCOMPLETE_AFTER)
			return reject("not_due", "Auto-complete is 14 days after shipping");
		by = "auto";
	} else return reject("not_allowed", "Only the buyer confirms receipt");
	return done({ ...invoice, status: "completed", completedAt: now }, [
		{ type: "invoice_completed", by },
		{ type: "feedback_opened" },
	]);
}

/**
 * A line's entry was rescinded or released.
 *
 * @spec SM-6-rescind-line — before payment the line is removed and the total recalculated
 * (an invoice with no lines left is cancelled); after the buyer paid, the line stays, marked refund owed
 * unless no refund is due.
 */
export function removeLine(invoice: Invoice, entryId: string, refundDue: boolean): InvoiceResult {
	if (!invoice.lines.some((l) => l.entryId === entryId)) return reject("line_not_found", "No such line");
	switch (invoice.status) {
		case "draft":
		case "sent":
		case "overdue": {
			const lines = invoice.lines.filter((l) => l.entryId !== entryId);
			const events: InvoiceEvent[] = [{ type: "line_removed", entryId }];
			if (lines.length === 0) {
				events.push({ type: "invoice_cancelled" });
				return done({ ...invoice, lines, status: "cancelled" }, events);
			}
			return done({ ...invoice, lines }, events);
		}
		case "buyer_paid":
		case "paid": {
			const lines = invoice.lines.map((l) => (l.entryId === entryId ? { ...l, refundOwed: refundDue } : l));
			return done({ ...invoice, lines }, refundDue ? [{ type: "line_refund_owed", entryId }] : []);
		}
		default:
			return reject("invalid_status", "Lines can't be removed after shipping");
	}
}
