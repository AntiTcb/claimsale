import { safeRedirect } from "#lib/server/onboarding.ts";
import { requireUser } from "#lib/server/sell.ts";
import { sellerReadiness } from "#lib/server/seller.ts";
import type { PageServerLoad } from "./$types";

/** What's missing before this account can sell (D55, D70); `requireSeller` sends people here. */
export const load: PageServerLoad = (event) => {
	const user = requireUser(event);
	return {
		blockers: sellerReadiness(user),
		next: safeRedirect(event.url.searchParams.get("next"), "/sell"),
	};
};
