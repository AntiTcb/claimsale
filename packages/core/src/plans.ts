import { DAY, HOUR, type Millis, type Tier } from "./common.ts";
import type { Cents } from "./money.ts";

/**
 * Free vs Pro limits and fixed timings (PLAN §3a, STATE_MACHINES). Kept in one
 * place so the engine, the UI and the tests agree.
 */

/** @spec SM-2-free-sale-cap — free sellers: at most 2 sales scheduled or live (D30). */
export const FREE_ACTIVE_SALE_CAP = 2;
/** @spec SM-2-free-item-cap — free sellers: at most 10 items per sale. */
export const FREE_ITEM_CAP = 10;
/** @spec SM-2-preview-window — the preview opens at most 7 days before go-live (D42). */
export const MAX_PREVIEW: Millis = 7 * DAY;
/** @spec SM-2-max-duration — a sale runs live for at most 14 days (D42). */
export const MAX_LIVE_DURATION: Millis = 14 * DAY;

/** The decision window for free sellers (D25). */
export const DEFAULT_DECISION_WINDOW: Millis = 24 * HOUR;

/** One counter round, open for 24h (D48). */
export const COUNTER_TTL: Millis = 24 * HOUR;

/** Payment deadline after an invoice is sent (D13). */
export const DEFAULT_PAYMENT_DEADLINE: Millis = 48 * HOUR;
export const PRO_SHORT_PAYMENT_DEADLINE: Millis = 24 * HOUR;

/** Tracking is required above this subtotal (D15). */
export const TRACKING_THRESHOLD: Record<Tier, Cents> = { free: 2000, pro: 4000 };

/** Auto-complete after shipping (D50). */
export const AUTOCOMPLETE_AFTER: Millis = 14 * DAY;

/** Pro buyer rescinds per calendar month (D24). */
export const PRO_BUYER_RESCINDS_PER_MONTH = 5;

/** Rescind contest window and the mutual-agreement response window (D51). */
export const CONTEST_WINDOW: Millis = 7 * DAY;
export const MUTUAL_RESPONSE_WINDOW: Millis = 72 * HOUR;
export const MIN_RESCIND_EXPLANATION = 20;

/**
 * The decision window a seller's sale uses.
 *
 * @spec SM-4.2-window-length
 *
 * Free sellers always get 24h. A Pro seller's configured value is used when it
 * is a positive duration, up to their cap: 7 days unless an admin approved a
 * longer one for them (D68).
 */
export function decisionWindow(sellerTier: Tier, configured?: Millis, cap?: Millis | null): Millis {
	if (sellerTier === "free" || configured === undefined || !(configured > 0)) return DEFAULT_DECISION_WINDOW;
	return Math.min(configured, decisionWindowCap(cap));
}

/** The longest decision window a Pro seller can set without an admin's approval (D68). */
export const MAX_DECISION_WINDOW: Millis = 7 * DAY;

/** The longest decision window an admin can approve for a seller (D68). */
export const MAX_APPROVED_DECISION_WINDOW: Millis = 30 * DAY;

/**
 * A seller's decision-window cap: the admin-approved one when set (never above
 * 30 days), otherwise 7 days.
 *
 * @spec SM-4.2-window-length
 */
export function decisionWindowCap(approved?: Millis | null): Millis {
	if (approved === undefined || approved === null || !(approved > 0)) return MAX_DECISION_WINDOW;
	return Math.min(approved, MAX_APPROVED_DECISION_WINDOW);
}

/**
 * The payment deadline for a seller's invoices.
 *
 * @spec SM-6-payment-deadline
 *
 * 48h by default; only Pro sellers can choose 24h.
 */
export function paymentDeadline(sellerTier: Tier, wantsShort: boolean): Millis {
	return sellerTier === "pro" && wantsShort ? PRO_SHORT_PAYMENT_DEADLINE : DEFAULT_PAYMENT_DEADLINE;
}
