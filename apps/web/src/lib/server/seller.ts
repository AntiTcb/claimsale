import { sellerBlockers, type SellerBlocker, type Tier } from "@claimsale/core";
import { redirect } from "@sveltejs/kit";

/**
 * The "start selling" gate (D55). `requireSeller(event)` in sell.ts, which every
 * /sell load and action calls, reads the tier through `entitlements()` and then
 * `assertSellerReady`; people who can't sell yet go to /sell/requirements, which
 * lists what's missing.
 *
 * @spec AUTH-seller-requirements — 18+, verified email and (unless Pro) verified phone, checked server-side.
 */

export interface SellerCandidate {
	readonly emailVerified: boolean;
	readonly ageAttested?: string | null | undefined;
	readonly phoneVerifiedAt?: Date | null | undefined;
}

/** What's missing for this user to sell at their seller tier (`[]`: ready). */
export function sellerReadiness(user: SellerCandidate, sellerTier: Tier): SellerBlocker[] {
	const ageAttested = user.ageAttested === "18+" || user.ageAttested === "13+" ? user.ageAttested : null;
	return sellerBlockers({
		ageAttested,
		emailVerified: user.emailVerified,
		phoneVerified: user.phoneVerifiedAt instanceof Date,
		pro: sellerTier === "pro",
	});
}

/** Redirects to /sell/requirements (back to this page afterwards) unless the user can sell. */
export function assertSellerReady(url: URL, user: SellerCandidate, sellerTier: Tier): void {
	if (sellerReadiness(user, sellerTier).length > 0) {
		redirect(303, `/sell/requirements?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
}
