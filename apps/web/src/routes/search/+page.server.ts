import { enabledGames, gameBySlug } from "@claimsale/core";
import { db } from "#lib/server/context.ts";
import { search } from "#lib/server/discovery.ts";
import type { PageServerLoad } from "./$types";

/**
 * Search over public sales and their items (D28, D56), plus the catalog products that
 * have listings, each linking to "who has this card?".
 *
 * @spec DISC-public-only — only public scheduled and live sales are searched.
 */
export const load: PageServerLoad = async ({ url }) => {
	const q = (url.searchParams.get("q") ?? "").slice(0, 120);
	const game = gameBySlug(url.searchParams.get("game") ?? "");
	const gameId = game?.enabled ? game.slug : null;
	return {
		q,
		gameId,
		games: enabledGames().map((g) => ({ slug: g.slug, name: g.name })),
		results: await search(db(), q, gameId),
	};
};
