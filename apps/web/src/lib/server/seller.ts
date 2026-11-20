import { sellerBlockers, type SellerBlocker } from "@claimsale/core";
import { redirect } from "@sveltejs/kit";

/**
 * The "start selling" gate (D55, D70). `requireSeller(event)` in sell.ts, which every
 * /sell load and action calls, checks it with `assertSellerReady`; people who can't
 * sell yet go to /sell/requirements, which lists what's missing.
 *
 * @spec AUTH-seller-requirements — 18+ and a verified email, checked server-side.
 */

export interface SellerCandidate {
	readonly emailVerified: boolean;
	readonly ageAttested?: string | null | undefined;
}

/** What's missing for this user to sell (`[]`: ready). */
export function sellerReadiness(user: SellerCandidate): SellerBlocker[] {
	const ageAttested = user.ageAttested === "18+" || user.ageAttested === "13+" ? user.ageAttested : null;
	return sellerBlockers({ ageAttested, emailVerified: user.emailVerified });
}

/** Redirects to /sell/requirements (back to this page afterwards) unless the user can sell. */
export function assertSellerReady(url: URL, user: SellerCandidate): void {
	if (sellerReadiness(user).length > 0) {
		redirect(303, `/sell/requirements?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
}
