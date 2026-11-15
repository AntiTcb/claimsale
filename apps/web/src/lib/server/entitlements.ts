import type { Millis, Tier } from "@claimsale/core";
import { and, eq, gt, inArray, isNull, or, type Db } from "@claimsale/db";
import { plans, subscriptions } from "@claimsale/db/schema";

/**
 * `entitlements(user)` (PLAN §3a): the user's seller and buyer tier, read from
 * `subscriptions` + `plans`. Every server-side limit check goes through here, so
 * Stripe Billing or an admin grant (WS-D) only has to write those rows.
 */

export interface Entitlements {
	readonly seller: Tier;
	readonly buyer: Tier;
}

export const FREE: Entitlements = { seller: "free", buyer: "free" };

const ACTIVE = ["active", "trialing", "granted"] as const;

export async function entitlements(db: Db, userId: string, now: Millis): Promise<Entitlements> {
	const rows = await db
		.select({ limits: plans.limits })
		.from(subscriptions)
		.innerJoin(plans, eq(plans.id, subscriptions.planId))
		.where(
			and(
				eq(subscriptions.userId, userId),
				inArray(subscriptions.status, [...ACTIVE]),
				or(isNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, now)),
			),
		)
		.all();
	let seller: Tier = "free";
	let buyer: Tier = "free";
	for (const { limits } of rows) {
		if (limits["seller"] === "pro") seller = "pro";
		if (limits["buyer"] === "pro") buyer = "pro";
	}
	return { seller, buyer };
}
