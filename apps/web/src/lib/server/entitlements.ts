import { entitlementsFor, type Entitlements } from "@claimsale/core";

/**
 * The one place the web Worker reads a user's plan. Until the `plans` /
 * `subscriptions` tables exist (IMPLEMENTATION_PLAN WS-A), every account is Free
 * unless the user record carries `tier: "pro"`; swap the body for a subscription
 * lookup then, and every caller follows. Async so that lookup can query D1.
 */
export async function entitlements(user: {
	readonly id: string;
	readonly tier?: unknown;
}): Promise<Entitlements> {
	return entitlementsFor(user.tier);
}
