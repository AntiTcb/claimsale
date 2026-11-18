import { ok, reject, type Millis, type Rejection, type Result, type Tier } from "@claimsale/core";
import { asc, eq, isNotNull, type Db } from "@claimsale/db";
import { users } from "@claimsale/db/schema";
import { DECISION_WINDOW_APPROVED_MAX_HOURS, DECISION_WINDOW_MAX_HOURS } from "#lib/listing-input.ts";
import { audit } from "./moderation.ts";

/**
 * Longer decision windows (D68): Pro sellers can set up to 7 days on their own and ask an
 * admin for a longer cap (up to 30 days). A seller has at most one pending request; the admin
 * approves it (the cap becomes the requested hours) or declines it, and can reset an approved
 * cap to the default. The engine reads the cap from `users.decision_window_max_hours`.
 */

export const WINDOW_REASON_MIN = 10;
export const WINDOW_REASON_MAX = 500;

export interface WindowRequest {
	readonly hours: number;
	readonly reason: string;
	readonly requestedAt: Millis;
}

export interface SellerWindow {
	/** The longest window this seller can set now, in hours. */
	readonly capHours: number;
	/** The admin-approved cap, or null for the default. */
	readonly approvedHours: number | null;
	readonly request: WindowRequest | null;
}

const capOf = (approved: number | null) =>
	approved !== null && approved > 0
		? Math.min(approved, DECISION_WINDOW_APPROVED_MAX_HOURS)
		: DECISION_WINDOW_MAX_HOURS;

/** @spec ADMIN-decision-window */
export async function sellerWindow(db: Db, userId: string): Promise<SellerWindow> {
	const row = await db
		.select({
			approved: users.decisionWindowMaxHours,
			hours: users.decisionWindowRequestHours,
			reason: users.decisionWindowRequestReason,
			at: users.decisionWindowRequestedAt,
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();
	const approved = row?.approved ?? null;
	return {
		capHours: capOf(approved),
		approvedHours: approved,
		request:
			row && row.hours !== null && row.at !== null
				? { hours: row.hours, reason: row.reason ?? "", requestedAt: row.at.getTime() }
				: null,
	};
}

/**
 * A Pro seller asks for a longer cap; a new request replaces a pending one.
 *
 * @spec ADMIN-decision-window
 */
export async function requestLongerWindow(
	db: Db,
	seller: { id: string; tier: Tier },
	input: { hours: string; reason: string },
	now: Millis,
): Promise<Result<true, Rejection>> {
	if (seller.tier !== "pro") return reject("not_allowed", "Longer decision windows are a Pro feature");
	const { capHours } = await sellerWindow(db, seller.id);
	const text = input.hours.trim();
	const hours = /^\d{1,4}$/.test(text) ? Number(text) : Number.NaN;
	if (!(hours > capHours && hours <= DECISION_WINDOW_APPROVED_MAX_HOURS)) {
		return reject(
			"invalid_hours",
			`Ask for whole hours from ${capHours + 1} to ${DECISION_WINDOW_APPROVED_MAX_HOURS}`,
		);
	}
	const reason = input.reason.trim();
	if (reason.length < WINDOW_REASON_MIN || reason.length > WINDOW_REASON_MAX) {
		return reject(
			"invalid_reason",
			`Tell the admin why in ${WINDOW_REASON_MIN} to ${WINDOW_REASON_MAX} characters`,
		);
	}
	await db
		.update(users)
		.set({
			decisionWindowRequestHours: hours,
			decisionWindowRequestReason: reason,
			decisionWindowRequestedAt: new Date(now),
			updatedAt: new Date(now),
		})
		.where(eq(users.id, seller.id));
	return ok(true);
}

export interface PendingWindowRequest extends WindowRequest {
	readonly userId: string;
	readonly handle: string | null;
	readonly displayName: string;
	readonly capHours: number;
}

/** Pending requests for the admin, oldest first. @spec ADMIN-decision-window */
export async function pendingWindowRequests(db: Db): Promise<PendingWindowRequest[]> {
	const rows = await db
		.select({
			userId: users.id,
			handle: users.handle,
			displayName: users.displayName,
			approved: users.decisionWindowMaxHours,
			hours: users.decisionWindowRequestHours,
			reason: users.decisionWindowRequestReason,
			at: users.decisionWindowRequestedAt,
		})
		.from(users)
		.where(isNotNull(users.decisionWindowRequestedAt))
		.orderBy(asc(users.decisionWindowRequestedAt))
		.limit(100)
		.all();
	return rows.flatMap((r) =>
		r.hours !== null && r.at !== null
			? [
					{
						userId: r.userId,
						handle: r.handle,
						displayName: r.displayName,
						capHours: capOf(r.approved),
						hours: r.hours,
						reason: r.reason ?? "",
						requestedAt: r.at.getTime(),
					},
				]
			: [],
	);
}

/**
 * The admin approves (the cap becomes the requested hours) or declines a pending request.
 *
 * @spec ADMIN-decision-window
 */
export async function decideWindowRequest(
	db: Db,
	input: { userId: string; adminId: string; approve: boolean },
	now: Millis,
): Promise<Result<true, Rejection>> {
	const { request } = await sellerWindow(db, input.userId);
	if (!request) return reject("no_request", "There's no pending request");
	const clear = {
		decisionWindowRequestHours: null,
		decisionWindowRequestReason: null,
		decisionWindowRequestedAt: null,
		updatedAt: new Date(now),
	};
	await db
		.update(users)
		.set(input.approve ? { ...clear, decisionWindowMaxHours: request.hours } : clear)
		.where(eq(users.id, input.userId));
	await audit(
		db,
		input.adminId,
		input.approve ? "admin_window_approve" : "admin_window_decline",
		{ userId: input.userId, hours: request.hours },
		now,
	);
	return ok(true);
}

/** The admin puts a seller back on the 7-day cap. @spec ADMIN-decision-window */
export async function resetWindowCap(
	db: Db,
	input: { userId: string; adminId: string },
	now: Millis,
): Promise<Result<true, Rejection>> {
	const { approvedHours } = await sellerWindow(db, input.userId);
	if (approvedHours === null) return reject("not_approved", "This seller is already on the default cap");
	await db
		.update(users)
		.set({ decisionWindowMaxHours: null, updatedAt: new Date(now) })
		.where(eq(users.id, input.userId));
	await audit(db, input.adminId, "admin_window_reset", { userId: input.userId }, now);
	return ok(true);
}
