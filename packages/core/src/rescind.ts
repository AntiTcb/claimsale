import { ok, reject, type Actor, type Millis, type Rejection, type Result } from "./common.ts";
import { CONTEST_WINDOW, MUTUAL_RESPONSE_WINDOW } from "./plans.ts";

/**
 * Seller rescind reasons and whose record they affect (STATE_MACHINES §4.3.1, D51).
 */

export type RescindReasonCode =
	| "buyer_nonpayment"
	| "buyer_unresponsive"
	| "buyer_payment_reversed"
	| "buyer_requested_after_payment"
	| "buyer_terms_violation"
	| "seller_item_unavailable"
	| "seller_listing_error"
	| "mutual_agreement"
	| "suspected_fraud";

export type Fault = "buyer" | "seller" | "neutral" | "review";
export type BuyerMark = "non_pay" | "payment_reversed" | "takeback" | "violation";
export type SellerMark = "seller_cancel";

interface Attribution {
	readonly fault: Fault;
	readonly buyerMark: BuyerMark | null;
	readonly sellerMark: SellerMark | null;
}

/**
 * The fault table.
 *
 * @spec SM-4.3.1-buyer-nonpayment
 * @spec SM-4.3.1-buyer-payment-reversed
 * @spec SM-4.3.1-buyer-requested-after-payment
 * @spec SM-4.3.1-buyer-terms-violation
 * @spec SM-4.3.1-seller-fault
 * @spec SM-4.3.1-mutual
 * @spec SM-4.3.1-fraud-review
 */
export const RESCIND_REASONS: Readonly<Record<RescindReasonCode, Attribution>> = {
	buyer_nonpayment: { fault: "buyer", buyerMark: "non_pay", sellerMark: null },
	buyer_unresponsive: { fault: "buyer", buyerMark: "non_pay", sellerMark: null },
	buyer_payment_reversed: { fault: "buyer", buyerMark: "payment_reversed", sellerMark: null },
	buyer_requested_after_payment: { fault: "buyer", buyerMark: "takeback", sellerMark: null },
	buyer_terms_violation: { fault: "buyer", buyerMark: "violation", sellerMark: null },
	seller_item_unavailable: { fault: "seller", buyerMark: null, sellerMark: "seller_cancel" },
	seller_listing_error: { fault: "seller", buyerMark: null, sellerMark: "seller_cancel" },
	mutual_agreement: { fault: "neutral", buyerMark: null, sellerMark: null },
	suspected_fraud: { fault: "review", buyerMark: null, sellerMark: null },
};

/** Where a rescind stands. Records only count once it is `final`. */
export type RescindPhase = "awaiting_buyer" | "contested" | "admin_review" | "final";

export interface Rescind {
	readonly reasonCode: RescindReasonCode;
	readonly fault: Fault;
	readonly phase: RescindPhase;
	readonly refundOwed: boolean;
	readonly createdAt: Millis;
	readonly contestedAt: Millis | null;
	readonly resolvedFault: Fault | null;
}

/**
 * Records a seller rescind.
 *
 * @spec SM-4.3.1-refund-owed — after `buyer_paid`, a refund is owed unless the payment was reversed.
 * @spec SM-4.3.1-mutual — mutual agreement waits for the buyer.
 * @spec SM-4.3.1-fraud-review — suspected fraud goes to the admin queue.
 */
export function createRescind(reasonCode: RescindReasonCode, afterBuyerPaid: boolean, now: Millis): Rescind {
	const { fault } = RESCIND_REASONS[reasonCode];
	const phase: RescindPhase =
		reasonCode === "mutual_agreement"
			? "awaiting_buyer"
			: reasonCode === "suspected_fraud"
				? "admin_review"
				: "final";
	return {
		reasonCode,
		fault,
		phase,
		refundOwed: afterBuyerPaid && reasonCode !== "buyer_payment_reversed",
		createdAt: now,
		contestedAt: null,
		resolvedFault: null,
	};
}

export interface RecordEffects {
	readonly buyer: BuyerMark | null;
	readonly seller: SellerMark | null;
}

/**
 * What the rescind counts against, right now. Nothing counts while it waits for the
 * buyer, is contested, or is under admin review.
 *
 * @spec SM-4.3.1-contest — a contest freezes the attribution until the admin resolves it.
 */
export function recordEffects(rescind: Rescind): RecordEffects {
	if (rescind.phase !== "final") return { buyer: null, seller: null };
	const fault = rescind.resolvedFault ?? rescind.fault;
	const table = RESCIND_REASONS[rescind.reasonCode];
	switch (fault) {
		case "buyer":
			// An admin can re-attribute to the buyer a rescind whose code had no buyer mark.
			return { buyer: table.buyerMark ?? "violation", seller: null };
		case "seller":
			return { buyer: null, seller: "seller_cancel" };
		default:
			return { buyer: null, seller: null };
	}
}

export type RescindRejection = Rejection<
	"not_allowed" | "invalid_phase" | "contest_window_closed" | "not_due"
>;
type RescindResult = Result<Rescind, RescindRejection>;

/**
 * The buyer contests the attribution.
 *
 * @spec SM-4.3.1-contest — within 7 days; the rescind goes to the admin queue.
 */
export function contest(rescind: Rescind, actor: Actor, buyerId: string, now: Millis): RescindResult {
	if (actor.kind !== "buyer" || actor.id !== buyerId)
		return reject("not_allowed", "Only the buyer can contest");
	if (rescind.phase !== "final" || rescind.contestedAt !== null) {
		return reject("invalid_phase", "This rescind can't be contested now");
	}
	if (now - rescind.createdAt > CONTEST_WINDOW) {
		return reject("contest_window_closed", "Rescinds can be contested within 7 days");
	}
	return ok({ ...rescind, phase: "contested", contestedAt: now });
}

/**
 * The admin resolves a contested or held rescind, optionally re-attributing it.
 *
 * @spec SM-4.3.1-contest
 * @spec SM-4.3.1-fraud-review
 */
export function resolve(rescind: Rescind, actor: Actor, fault: Fault): RescindResult {
	if (actor.kind !== "admin") return reject("not_allowed", "Only an admin can resolve a rescind");
	if (rescind.phase !== "contested" && rescind.phase !== "admin_review") {
		return reject("invalid_phase", "Nothing to resolve");
	}
	if (fault === "review") return reject("invalid_phase", "Pick buyer, seller or neutral");
	return ok({ ...rescind, phase: "final", resolvedFault: fault });
}

/**
 * The buyer answers a mutual-agreement rescind, or 72h pass without an answer.
 *
 * @spec SM-4.3.1-mutual — agreeing, or no answer in 72h, makes it neutral; disputing sends it to the admin.
 */
export function answerMutual(
	rescind: Rescind,
	actor: Actor,
	buyerId: string,
	answer: "agree" | "dispute" | "timeout",
	now: Millis,
): RescindResult {
	if (rescind.phase !== "awaiting_buyer") return reject("invalid_phase", "No answer is pending");
	if (answer === "timeout") {
		if (now - rescind.createdAt < MUTUAL_RESPONSE_WINDOW)
			return reject("not_due", "The buyer still has time to answer");
		return ok({ ...rescind, phase: "final" });
	}
	if (actor.kind !== "buyer" || actor.id !== buyerId)
		return reject("not_allowed", "Only the buyer can answer");
	return answer === "agree"
		? ok({ ...rescind, phase: "final" })
		: ok({ ...rescind, phase: "contested", contestedAt: now });
}

// ---------------------------------------------------------------------------
// Stored rescinds, contests and records (WS-I)

export const RESCIND_REASON_CODES: readonly RescindReasonCode[] = [
	"buyer_nonpayment",
	"buyer_unresponsive",
	"buyer_payment_reversed",
	"buyer_requested_after_payment",
	"buyer_terms_violation",
	"seller_item_unavailable",
	"seller_listing_error",
	"mutual_agreement",
	"suspected_fraud",
];

export function isRescindReasonCode(value: string): value is RescindReasonCode {
	return Object.hasOwn(RESCIND_REASONS, value);
}

/** The faults an admin can resolve a rescind to. */
export const RESOLVED_FAULTS = ["buyer", "seller", "neutral"] as const;
export type ResolvedFault = (typeof RESOLVED_FAULTS)[number];

export function isResolvedFault(value: string): value is ResolvedFault {
	return (RESOLVED_FAULTS as readonly string[]).includes(value);
}

const PHASES: readonly RescindPhase[] = ["awaiting_buyer", "contested", "admin_review", "final"];
const isPhase = (value: string): value is RescindPhase => (PHASES as readonly string[]).includes(value);

/** A `rescinds` row, as stored (rows written before WS-I have no `phase`). */
export interface StoredRescind {
	readonly reasonCode: string;
	readonly phase: string | null;
	readonly refundOwed: boolean;
	readonly createdAt: Millis;
	readonly contestedAt: Millis | null;
	readonly resolvedFault: string | null;
	readonly resolvedAt: Millis | null;
}

/**
 * A stored rescind as core's `Rescind`, or null if its reason code is unknown. Rows from
 * before the `phase` column get it derived from the other columns.
 */
export function fromStored(row: StoredRescind): Rescind | null {
	if (!isRescindReasonCode(row.reasonCode)) return null;
	const { fault } = RESCIND_REASONS[row.reasonCode];
	const resolvedFault =
		row.resolvedFault !== null && isResolvedFault(row.resolvedFault) ? row.resolvedFault : null;
	let phase: RescindPhase;
	if (row.phase !== null && isPhase(row.phase)) phase = row.phase;
	else if (row.resolvedAt !== null) phase = "final";
	else if (row.contestedAt !== null) phase = "contested";
	else if (row.reasonCode === "suspected_fraud") phase = "admin_review";
	else if (row.reasonCode === "mutual_agreement") phase = "awaiting_buyer";
	else phase = "final";
	return {
		reasonCode: row.reasonCode,
		fault,
		phase,
		refundOwed: row.refundOwed,
		createdAt: row.createdAt,
		contestedAt: row.contestedAt,
		resolvedFault,
	};
}

/**
 * When a mutual-agreement rescind stops waiting for the buyer (null if it isn't waiting).
 *
 * @spec SM-4.3.1-mutual — no answer within 72h counts as agreement.
 */
export function mutualAnswerDueAt(rescind: Rescind): Millis | null {
	return rescind.phase === "awaiting_buyer" ? rescind.createdAt + MUTUAL_RESPONSE_WINDOW : null;
}

/**
 * Until when the buyer can contest the attribution (null when they can't now).
 *
 * @spec SM-4.3.1-contest
 */
export function contestOpenUntil(rescind: Rescind, now: Millis): Millis | null {
	const until = rescind.createdAt + CONTEST_WINDOW;
	return rescind.phase === "final" && rescind.contestedAt === null && now <= until ? until : null;
}

export const MIN_CONTEST_TEXT = 10;
export const MAX_CONTEST_TEXT = 2000;

/**
 * The buyer's side of a contest: required, 10 to 2000 characters after trimming.
 *
 * @spec SM-4.3.1-contest — the buyer contests "by giving their side".
 */
export function validateContestText(text: string): Result<string, Rejection<"contest_text_invalid">> {
	const trimmed = text.trim();
	if (trimmed.length < MIN_CONTEST_TEXT || trimmed.length > MAX_CONTEST_TEXT) {
		return reject(
			"contest_text_invalid",
			`Tell the admin your side in ${MIN_CONTEST_TEXT} to ${MAX_CONTEST_TEXT} characters`,
		);
	}
	return ok(trimmed);
}

/**
 * A buyer-fault rescind that the buyer contested and the admin moved off the buyer.
 *
 * @spec SM-4.3.1-abuse-guard
 */
export function isOverturned(rescind: Rescind): boolean {
	return (
		rescind.phase === "final" &&
		rescind.contestedAt !== null &&
		rescind.fault === "buyer" &&
		rescind.resolvedFault !== null &&
		rescind.resolvedFault !== "buyer"
	);
}

/** Overturned buyer-fault rescinds after which a seller is flagged for admin review. */
export const OVERTURNED_RESCINDS_FLAG_AT = 3;

/**
 * Whether a seller with this many overturned buyer-fault rescinds goes to the admin queue.
 *
 * @spec SM-4.3.1-abuse-guard — repeatedly overturned buyer-fault rescinds flag the seller.
 */
export function flagsSeller(overturned: number): boolean {
	return overturned >= OVERTURNED_RESCINDS_FLAG_AT;
}

/** What a seller sees about a claimant at a glance (PLAN §3b). */
export interface BuyerReputation {
	readonly completedPurchases: number;
	readonly nonPay: number;
	readonly paymentReversed: number;
	/** Approved take-backs plus `buyer_requested_after_payment` rescinds. */
	readonly takebacks: number;
	readonly violations: number;
	readonly proRescinds: number;
	readonly memberSince: Millis;
}

export interface BuyerReputationInput {
	/** Every seller rescind against the buyer, in any phase. */
	readonly rescinds: readonly Rescind[];
	readonly completedPurchases: number;
	readonly approvedTakebacks: number;
	readonly proRescinds: number;
	readonly memberSince: Millis;
}

/**
 * A buyer's record. Only final rescinds count, by their resolved fault: one that waits
 * for the buyer, is contested or is under admin review counts for no one.
 *
 * @spec REP-buyer-record
 */
export function buyerRecord(input: BuyerReputationInput): BuyerReputation {
	const marks = { non_pay: 0, payment_reversed: 0, takeback: 0, violation: 0 };
	for (const rescind of input.rescinds) {
		const mark = recordEffects(rescind).buyer;
		if (mark !== null) marks[mark]++;
	}
	return {
		completedPurchases: input.completedPurchases,
		nonPay: marks.non_pay,
		paymentReversed: marks.payment_reversed,
		takebacks: input.approvedTakebacks + marks.takeback,
		violations: marks.violation,
		proRescinds: input.proRescinds,
		memberSince: input.memberSince,
	};
}
