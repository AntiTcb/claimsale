import { sellerBlockers, type Entitlements, type SellerBlocker } from "@claimsale/core";
import { redirect } from "@sveltejs/kit";
import { entitlements } from "./entitlements.ts";

/**
 * The "start selling" gate (D55). Seller pages and actions (create, schedule,
 * publish) call `requireSeller(event)` first; it sends people who can't sell yet
 * to /sell/requirements, which lists what's missing.
 *
 * @spec AUTH-seller-requirements — 18+, verified email and (unless Pro) verified phone, checked server-side.
 */

export interface SellerCandidate {
	readonly id: string;
	readonly emailVerified: boolean;
	readonly ageAttested?: string | null | undefined;
	readonly phoneVerifiedAt?: Date | null | undefined;
	readonly tier?: unknown;
}

export interface SellerReadiness {
	readonly blockers: SellerBlocker[];
	readonly entitlements: Entitlements;
}

export async function sellerReadiness(user: SellerCandidate): Promise<SellerReadiness> {
	const plan = await entitlements(user);
	const ageAttested = user.ageAttested === "18+" || user.ageAttested === "13+" ? user.ageAttested : null;
	return {
		entitlements: plan,
		blockers: sellerBlockers({
			ageAttested,
			emailVerified: user.emailVerified,
			phoneVerified: user.phoneVerifiedAt instanceof Date,
			pro: !plan.sellerPhoneRequired,
		}),
	};
}

interface GateEvent {
	readonly locals: { readonly user: SellerCandidate | null };
	readonly url: URL;
}

/**
 * Returns the signed-in seller and their plan, or redirects: to /login when signed
 * out, to /sell/requirements (with `next`) when something is missing.
 */
export async function requireSeller<U extends SellerCandidate>(
	event: GateEvent & { readonly locals: { readonly user: U | null } },
): Promise<{ user: U; entitlements: Entitlements }> {
	const next = encodeURIComponent(event.url.pathname + event.url.search);
	const user = event.locals.user;
	if (!user) redirect(303, `/login?next=${next}`);
	const readiness = await sellerReadiness(user);
	if (readiness.blockers.length > 0) redirect(303, `/sell/requirements?next=${next}`);
	return { user, entitlements: readiness.entitlements };
}
