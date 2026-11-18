import {
	RESCIND_REASON_CODES,
	RESCIND_REASONS,
	type BuyerReputation,
	type Cents,
	type EntryKind,
	type EntryStatus,
	type ItemState,
	type Millis,
	type RescindPhase,
	type RescindReasonCode,
} from "@claimsale/core";

/**
 * The seller control room's view model (`/sell/[saleId]/manage`), shared by the server
 * load and the components. Everything here is the seller's own data; buyers appear by
 * handle and display name only, never by email or phone.
 */

export interface QueueEntry {
	readonly id: string;
	readonly buyerId: string;
	readonly kind: EntryKind;
	readonly amountCents: Cents;
	readonly status: EntryStatus;
	readonly createdAt: Millis;
	readonly counterCents: Cents | null;
	readonly counterExpiresAt: Millis | null;
	readonly wonAt: Millis | null;
	/** The status of the invoice holding a won entry's line. */
	readonly invoiceStatus: string | null;
}

export interface ControlItem {
	readonly id: string;
	readonly title: string;
	readonly priceCents: Cents;
	readonly quantity: number;
	readonly state: ItemState;
	readonly decisionDeadline: Millis | null;
	readonly offersLapseAt: Millis | null;
	readonly winners: readonly QueueEntry[];
	/** Open claims and offers in rank order (STATE_MACHINES §1): the first ones decide or back up. */
	readonly queue: readonly QueueEntry[];
	/** Offers the seller countered, waiting for the buyer. */
	readonly countered: readonly QueueEntry[];
}

export interface BuyerSummary {
	readonly id: string;
	readonly handle: string | null;
	readonly displayName: string;
	readonly record: BuyerReputation;
}

export interface PendingTakeback {
	readonly id: string;
	readonly entryId: string;
	readonly itemId: string;
	readonly itemTitle: string;
	readonly buyerId: string;
	readonly reason: string | null;
	readonly createdAt: Millis;
}

export interface SaleRescind {
	readonly id: string;
	readonly entryId: string;
	readonly itemTitle: string;
	readonly buyerId: string;
	readonly reasonCode: RescindReasonCode;
	readonly explanation: string;
	readonly phase: RescindPhase;
	readonly refundOwed: boolean;
	readonly createdAt: Millis;
	readonly resolvedFault: string | null;
}

export interface ControlRoom {
	readonly items: readonly ControlItem[];
	readonly buyers: Readonly<Record<string, BuyerSummary>>;
	readonly takebacks: readonly PendingTakeback[];
	readonly rescinds: readonly SaleRescind[];
}

/** The seller's wording for each rescind reason, with who it counts against (D51). */
export const RESCIND_REASON_LABELS: Readonly<Record<RescindReasonCode, string>> = {
	buyer_nonpayment: "Buyer didn't pay by the deadline",
	buyer_unresponsive: "Buyer stopped replying",
	buyer_payment_reversed: "Buyer reversed the payment",
	buyer_requested_after_payment: "Buyer asked to cancel after paying",
	buyer_terms_violation: "Buyer broke the sale's terms",
	seller_item_unavailable: "Item lost, damaged or sold elsewhere",
	seller_listing_error: "Listing mistake (price, set or condition)",
	mutual_agreement: "We both agreed (the buyer confirms)",
	suspected_fraud: "Suspected fraud (goes to review)",
};

const FAULT_NOTE: Readonly<Record<string, string>> = {
	buyer: "counts on the buyer's record",
	seller: "counts on your record",
	neutral: "counts for no one",
	review: "held for admin review",
};

/** Rescind reasons for the form: the code, its label and whose record it affects. */
export const RESCIND_REASON_OPTIONS = RESCIND_REASON_CODES.map((code) => ({
	code,
	label: RESCIND_REASON_LABELS[code],
	note: FAULT_NOTE[RESCIND_REASONS[code].fault] ?? "",
}));

export const PHASE_LABELS: Readonly<Record<RescindPhase, string>> = {
	awaiting_buyer: "Waiting for the buyer to confirm",
	contested: "Contested; an admin will decide",
	admin_review: "Held for admin review",
	final: "Final",
};

/** "12 completed · 1 non-pay · member since Nov 2025": the record at a glance (PLAN §3b). */
export function describeRecord(record: BuyerReputation): string {
	const parts = [`${record.completedPurchases} completed`];
	if (record.nonPay > 0) parts.push(`${record.nonPay} non-pay`);
	if (record.paymentReversed > 0) parts.push(`${record.paymentReversed} payment reversed`);
	if (record.takebacks > 0) parts.push(`${record.takebacks} take-back${record.takebacks === 1 ? "" : "s"}`);
	if (record.violations > 0)
		parts.push(`${record.violations} violation${record.violations === 1 ? "" : "s"}`);
	if (record.proRescinds > 0)
		parts.push(`${record.proRescinds} Pro rescind${record.proRescinds === 1 ? "" : "s"}`);
	const since = new Date(record.memberSince).toLocaleDateString("en-US", {
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	});
	parts.push(`member since ${since}`);
	return parts.join(" · ");
}

/** "2h 15m", "3d 4h", "45s": the time left on a countdown. */
export function formatRemaining(ms: Millis): string {
	if (ms <= 0) return "0s";
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86_400);
	const h = Math.floor((s % 86_400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${s}s`;
}

/** The label for a buyer in the control room: "@handle" or their display name. */
export function buyerLabel(buyer: BuyerSummary | undefined): string {
	if (!buyer) return "A buyer";
	return buyer.handle ? `@${buyer.handle}` : buyer.displayName;
}
