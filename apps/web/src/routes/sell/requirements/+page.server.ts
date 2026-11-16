import { db } from "#lib/server/context.ts";
import { entitlements } from "#lib/server/entitlements.ts";
import { safeRedirect } from "#lib/server/onboarding.ts";
import { requireUser } from "#lib/server/sell.ts";
import { sellerReadiness } from "#lib/server/seller.ts";
import { verifiedPhone } from "#lib/server/users.ts";
import type { PageServerLoad } from "./$types";

/** What's missing before this account can sell (D55); `requireSeller` sends people here. */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const { seller } = await entitlements(db(), user.id, Date.now());
	// The phone straight from D1, in case it was verified a moment ago in another tab.
	const phone = await verifiedPhone(db(), user.id);
	return {
		blockers: sellerReadiness({ ...user, phoneVerifiedAt: phone ? new Date() : null }, seller),
		pro: seller === "pro",
		next: safeRedirect(event.url.searchParams.get("next"), "/sell"),
	};
};
