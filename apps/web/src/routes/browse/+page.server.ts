import { enabledGames } from "@claimsale/core";
import { db } from "#lib/server/context.ts";
import { itemCountsByGame, listSales } from "#lib/server/discovery.ts";
import type { PageServerLoad } from "./$types";

/** Browse (D28): games, live sales and upcoming ones. Public sales only (DISC-public-only). */
export const load: PageServerLoad = async () => {
	const [counts, live, upcoming] = await Promise.all([
		itemCountsByGame(db()),
		listSales(db(), { order: "live", limit: 24 }),
		listSales(db(), { order: "upcoming", limit: 24 }),
	]);
	return {
		games: enabledGames().map((g) => ({ slug: g.slug, name: g.name, items: counts.get(g.slug) ?? 0 })),
		live,
		upcoming,
	};
};
