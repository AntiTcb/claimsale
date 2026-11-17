import type {
	EndedReason,
	Entry,
	EntryKind,
	EntryStatus,
	Invoice,
	InvoiceLine,
	InvoiceStatus,
	Item,
	ItemState,
	Millis,
	SaleStatus,
	Tier,
	TakebackRequest,
	TakebackStatus,
} from "@claimsale/core";

/**
 * D1 rows as the engine reads them (raw SQL, snake_case), and their mapping onto the
 * pure types in `@claimsale/core`. Money is integer cents; timestamps are integer ms.
 */

export interface SaleRow {
	readonly id: string;
	readonly seller_id: string;
	readonly status: SaleStatus;
	readonly live_at: Millis | null;
	readonly closes_at: Millis | null;
	readonly title: string;
	readonly terms: string | null;
	readonly shipping: string | null;
	readonly item_count: number;
	readonly seller_pro: number;
}

export interface ItemRow {
	readonly id: string;
	readonly sale_id: string;
	readonly title: string;
	readonly price_cents: number;
	readonly quantity: number;
	readonly per_buyer_limit: number;
	readonly offers_mode: "off" | "on" | "on_min";
	readonly min_offer_cents: number | null;
	readonly state: ItemState;
	readonly withdrawn_at: Millis | null;
	readonly decision_deadline: Millis | null;
	readonly offers_lapse_at: Millis | null;
	readonly units_won: number;
	readonly version: number;
}

export interface EntryRow {
	readonly id: string;
	readonly item_id: string;
	readonly user_id: string;
	readonly kind: EntryKind;
	readonly amount_cents: number;
	readonly status: EntryStatus;
	readonly rank_override: number | null;
	readonly counter_cents: number | null;
	readonly counter_expires_at: Millis | null;
	readonly won_at: Millis | null;
	readonly ended_at: Millis | null;
	readonly ended_reason: string | null;
	readonly ended_by: string | null;
	readonly created_at: Millis;
}

export interface InvoiceRow {
	readonly id: string;
	readonly sale_id: string;
	readonly buyer_id: string;
	readonly seller_id: string;
	readonly invoice_number: number | null;
	readonly status: InvoiceStatus;
	readonly shipping_cents: number;
	readonly adjustment_cents: number;
	readonly gmv_cents: number | null;
	readonly shipping_option_id: string | null;
	readonly payment_ref: string | null;
	readonly carrier: string | null;
	readonly tracking_number: string | null;
	readonly sent_at: Millis | null;
	readonly due_at: Millis | null;
	readonly buyer_paid_at: Millis | null;
	readonly paid_at: Millis | null;
	readonly shipped_at: Millis | null;
	readonly completed_at: Millis | null;
	readonly updated_at: Millis;
}

export interface InvoiceLineRow {
	readonly id: string;
	readonly invoice_id: string;
	readonly entry_id: string;
	readonly description: string;
	readonly amount_cents: number;
	readonly refund_owed: number;
}

export interface TakebackRow {
	readonly id: string;
	readonly entry_id: string;
	readonly buyer_id: string;
	readonly reason: string | null;
	readonly status: TakebackStatus;
	readonly created_at: Millis;
	readonly decided_at: Millis | null;
}

export interface BuyerRow {
	readonly id: string;
	readonly email_verified: number;
	readonly created_at: Millis;
	readonly blocked: number;
	readonly buyer_pro: number;
}

export const tierOf = (pro: number | boolean): Tier => (pro ? "pro" : "free");

export function toEntry(row: EntryRow): Entry {
	return {
		id: row.id,
		buyerId: row.user_id,
		kind: row.kind,
		amountCents: row.amount_cents,
		status: row.status,
		createdAt: row.created_at,
		rankOverride: row.rank_override,
		counterCents: row.counter_cents,
		counterExpiresAt: row.counter_expires_at,
		wonAt: row.won_at,
		endedAt: row.ended_at,
		endedReason: row.ended_reason as EndedReason | null,
		endedBy: row.ended_by,
	};
}

export function toItem(row: ItemRow, entries: readonly EntryRow[]): Item {
	return {
		id: row.id,
		priceCents: row.price_cents,
		quantity: row.quantity,
		perBuyerLimit: row.per_buyer_limit,
		offersEnabled: row.offers_mode !== "off",
		minOfferCents: row.offers_mode === "on_min" ? row.min_offer_cents : null,
		decisionDeadline: row.decision_deadline,
		offersLapseAt: row.offers_lapse_at,
		withdrawn: row.withdrawn_at !== null,
		entries: entries
			.filter((e) => e.item_id === row.id)
			.toSorted((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
			.map(toEntry),
	};
}

export function toInvoice(row: InvoiceRow, lines: readonly InvoiceLineRow[], sellerTier: Tier): Invoice {
	return {
		id: row.id,
		buyerId: row.buyer_id,
		sellerId: row.seller_id,
		sellerTier,
		status: row.status,
		lines: lines
			.filter((l) => l.invoice_id === row.id)
			.map(
				(l): InvoiceLine => ({
					entryId: l.entry_id,
					description: l.description,
					amountCents: l.amount_cents,
					refundOwed: l.refund_owed === 1,
				}),
			),
		shippingCents: row.shipping_cents,
		adjustmentCents: row.adjustment_cents,
		shippingOptionId: row.shipping_option_id,
		paymentRef: row.payment_ref,
		tracking:
			row.carrier !== null && row.tracking_number !== null
				? { carrier: row.carrier, number: row.tracking_number }
				: null,
		sentAt: row.sent_at,
		dueAt: row.due_at,
		// Core's `paidAt` is when the buyer marked it paid; `paid_at` is the seller's confirmation.
		paidAt: row.buyer_paid_at,
		shippedAt: row.shipped_at,
		completedAt: row.completed_at,
		gmvCents: row.gmv_cents,
	};
}

export function toTakeback(row: TakebackRow): TakebackRequest {
	return {
		id: row.id,
		entryId: row.entry_id,
		buyerId: row.buyer_id,
		status: row.status,
		createdAt: row.created_at,
		decidedAt: row.decided_at,
	};
}
