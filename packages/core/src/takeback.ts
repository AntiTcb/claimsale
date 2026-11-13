import { ok, reject, type Actor, type Millis, type Rejection, type Result, type UserId } from "./common.ts";
import type { InvoiceStatus } from "./invoice.ts";

/** Take-back requests (STATE_MACHINES §5). */

export type TakebackStatus = "pending" | "approved" | "denied" | "cancelled";

export interface TakebackRequest {
	readonly id: string;
	readonly entryId: string;
	readonly buyerId: UserId;
	readonly status: TakebackStatus;
	readonly createdAt: Millis;
	readonly decidedAt: Millis | null;
}

export type TakebackRejection = Rejection<
	"not_allowed" | "not_won" | "already_pending" | "denied_before" | "invoice_paid" | "invalid_status"
>;

/** Invoice states in which a take-back can still be filed (D52: until the buyer marks it paid). */
const OPEN_FOR_TAKEBACK: ReadonlySet<InvoiceStatus | "none"> = new Set(["none", "draft", "sent", "overdue"]);

export interface RequestTakebackInput {
	readonly requestId: string;
	readonly entryId: string;
	readonly entryBuyerId: UserId;
	readonly entryWon: boolean;
	/** The status of the invoice holding the entry, or `none` before it has one. */
	readonly invoiceStatus: InvoiceStatus | "none";
	/** Earlier requests for this entry. */
	readonly previous: readonly TakebackRequest[];
}

/**
 * The buyer asks to give a win back. The entry stays `won` (and binding) while it's pending.
 *
 * @spec SM-5-takeback-request — one pending request per entry, filed until the invoice is marked paid.
 * @spec SM-5-takeback-decide — after a denial the buyer can't file again for the entry.
 */
export function requestTakeback(
	actor: Actor,
	input: RequestTakebackInput,
	now: Millis,
): Result<TakebackRequest, TakebackRejection> {
	if (actor.kind !== "buyer" || actor.id !== input.entryBuyerId)
		return reject("not_allowed", "Only the winner can ask");
	if (!input.entryWon) return reject("not_won", "Only a won item can be given back");
	if (input.previous.some((r) => r.status === "pending"))
		return reject("already_pending", "A request is already pending");
	if (input.previous.some((r) => r.status === "denied")) {
		return reject("denied_before", "The seller already declined a take-back for this item");
	}
	if (!OPEN_FOR_TAKEBACK.has(input.invoiceStatus)) {
		return reject("invoice_paid", "Take-backs can be requested until the invoice is marked paid");
	}
	return ok({
		id: input.requestId,
		entryId: input.entryId,
		buyerId: actor.id,
		status: "pending",
		createdAt: now,
		decidedAt: null,
	});
}

/**
 * The seller approves or denies. Approval is followed by `releaseForTakeback` on the item.
 *
 * @spec SM-5-takeback-decide
 */
export function decideTakeback(
	request: TakebackRequest,
	actor: Actor,
	sellerId: UserId,
	approve: boolean,
	now: Millis,
): Result<TakebackRequest, TakebackRejection> {
	if (actor.kind !== "seller" || actor.id !== sellerId)
		return reject("not_allowed", "Only the seller decides");
	if (request.status !== "pending") return reject("invalid_status", "The request was already decided");
	return ok({ ...request, status: approve ? "approved" : "denied", decidedAt: now });
}

/** The buyer cancels, or the entry ended some other way. */
export function cancelTakeback(
	request: TakebackRequest,
	actor: Actor,
	now: Millis,
): Result<TakebackRequest, TakebackRejection> {
	const byBuyer = actor.kind === "buyer" && actor.id === request.buyerId;
	if (!byBuyer && actor.kind !== "system") return reject("not_allowed", "Only the buyer can cancel");
	if (request.status !== "pending") return reject("invalid_status", "The request was already decided");
	return ok({ ...request, status: "cancelled", decidedAt: now });
}
