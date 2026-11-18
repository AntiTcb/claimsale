import { gameBySlug, itemFiltersQuery, parseItemFilters } from "@claimsale/core";
import { error } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { gameFacets, listGameItems } from "#lib/server/discovery.ts";
import type { PageServerLoad } from "./$types";

/**
 * Browse by game (PLAN §3: `/g/pokemon`), then kind, condition, set, rarity, language,
 * finish and price. Filters are a GET form, so every filtered view has a shareable URL.
 *
 * @spec DISC-public-only — items of public scheduled and live sales only.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const game = gameBySlug(params.game);
	if (!game?.enabled) error(404, "No such game");
	const filters = parseItemFilters(url.searchParams);
	const [{ items, hasMore }, facets] = await Promise.all([
		listGameItems(db(), game.slug, filters),
		gameFacets(db(), game.slug),
	]);
	return {
		game: { slug: game.slug, name: game.name, conditionScale: [...game.conditionScale] },
		filters,
		facets,
		items,
		prev: filters.page > 1 ? itemFiltersQuery(filters, { page: filters.page - 1 }) || "?" : null,
		next: hasMore ? itemFiltersQuery(filters, { page: filters.page + 1 }) : null,
	};
};
