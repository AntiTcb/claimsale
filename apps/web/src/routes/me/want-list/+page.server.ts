import { CONDITION_LABELS, CONDITIONS, FINISH_LABELS, gameBySlug, LANGUAGE_LABELS } from "@claimsale/core";
import { fail } from "@sveltejs/kit";
import { db, engineRpc } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { requireUser } from "#lib/server/sell.ts";
import { addWant, listWants, removeWant } from "#lib/server/want-list.ts";
import type { Actions, PageServerLoad } from "./$types";

const finishLabels: Readonly<Record<string, string>> = FINISH_LABELS;
const languageLabels: Readonly<Record<string, string>> = LANGUAGE_LABELS;

interface SearchHit {
	readonly productId: number;
	readonly name: string;
	readonly setName: string;
	readonly number: string | null;
	readonly game: string;
	readonly finishes: ReadonlyArray<{ id: string; label: string }>;
	readonly languages: ReadonlyArray<{ id: string; label: string }>;
}

/** Catalog search for the want list (autofill fields only, never a price: TCG-market-placeholder). */
async function search(query: string): Promise<{ hits: SearchHit[]; unavailable: boolean }> {
	if (query.trim().length < 2) return { hits: [], unavailable: false };
	try {
		const result = await engineRpc().searchCatalog({ query: query.slice(0, 100), limit: 10 });
		if (!result.ok) return { hits: [], unavailable: true };
		return {
			unavailable: false,
			hits: result.value.map((hit) => {
				const game = gameBySlug(hit.game);
				return {
					productId: hit.productId,
					name: hit.name,
					setName: hit.setName,
					number: hit.number,
					game: game?.name ?? hit.game,
					finishes: (game?.finishes ?? []).map((id) => ({ id, label: FINISH_LABELS[id] })),
					languages: (game?.languages ?? []).map((id) => ({ id, label: LANGUAGE_LABELS[id] })),
				};
			}),
		};
	} catch {
		return { hits: [], unavailable: true };
	}
}

/**
 * The buyer's want list (D61): cards they're looking for, matched against new public sales
 * (TCG-want-list-notify).
 */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const query = event.url.searchParams.get("q") ?? "";
	const [wants, found] = await Promise.all([listWants(db(), user.id), search(query)]);
	return {
		query,
		wants: wants.map((w) => ({
			...w,
			finishLabel: w.finish ? (finishLabels[w.finish] ?? w.finish) : null,
			languageLabel: w.language ? (languageLabels[w.language] ?? w.language) : null,
		})),
		hits: found.hits,
		searchUnavailable: found.unavailable,
		conditions: CONDITIONS.map((id) => ({ id, label: CONDITION_LABELS[id] })),
	};
};

export const actions: Actions = {
	add: async (event) => {
		const user = requireUser(event);
		const data = await event.request.formData();
		const added = await addWant(
			db(),
			user.id,
			{
				productId: field(data, "productId"),
				finish: field(data, "finish"),
				minCondition: field(data, "minCondition"),
				language: field(data, "language"),
				maxPrice: field(data, "maxPrice"),
			},
			Date.now(),
		);
		if (!added.ok)
			return fail(400, {
				action: "add" as const,
				productId: field(data, "productId"),
				message: added.error.message,
			});
		return { action: "add" as const, added: true };
	},

	remove: async (event) => {
		const user = requireUser(event);
		await removeWant(db(), user.id, field(await event.request.formData(), "id"));
		return { action: "remove" as const, removed: true };
	},
};
