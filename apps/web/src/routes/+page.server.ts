import { enabledGames } from "@claimsale/core";
import { db } from "#lib/server/context.ts";
import { listSales } from "#lib/server/discovery.ts";
import { followedSellerIds } from "#lib/server/follows.ts";
import { listSellerSales } from "#lib/server/sales.ts";
import type { PageServerLoad } from "./$types";

/**
 * The landing page (PLAN §7): what ClaimSale is, live and upcoming public sales, and for a
 * signed-in user their own active sales and the sales of sellers they follow.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	const [live, upcoming, mine, followed] = await Promise.all([
		listSales(db(), { order: "live", limit: 6 }),
		listSales(db(), { order: "upcoming", limit: 6 }),
		user ? listSellerSales(db(), user.id) : [],
		user ? followedSellerIds(db(), user.id) : [],
	]);
	const followedSales =
		followed.length === 0
			? []
			: [
					...(await listSales(db(), { order: "live", sellerIds: followed, limit: 6 })),
					...(await listSales(db(), { order: "upcoming", sellerIds: followed, limit: 6 })),
				];
	return {
		games: enabledGames().map((g) => ({ slug: g.slug, name: g.name })),
		live,
		upcoming,
		mySales: mine
			.filter((s) => s.status === "draft" || s.status === "scheduled" || s.status === "live")
			.slice(0, 6),
		followedSales,
		follows: followed.length,
	};
};
