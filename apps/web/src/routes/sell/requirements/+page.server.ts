import { redirect } from "@sveltejs/kit";
import { safeRedirect } from "#lib/server/onboarding.ts";
import { sellerReadiness } from "#lib/server/seller.ts";
import type { PageServerLoad } from "./$types";

/** What's missing before this account can sell (D55); `requireSeller` sends people here. */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	const readiness = await sellerReadiness(locals.user);
	return {
		blockers: readiness.blockers,
		pro: readiness.entitlements.tier === "pro",
		next: safeRedirect(url.searchParams.get("next"), "/sell"),
	};
};
