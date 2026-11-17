import { error, redirect } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { photosByItem } from "#lib/server/images.ts";
import { findItem } from "#lib/server/items.ts";
import { loadSaleForViewer, publicItem, saleBody, saleHeader } from "#lib/server/sale-view.ts";
import type { PageServerLoad } from "./$types";

/**
 * Item detail, read-only until the live grid (WS-H) adds claim and offer.
 *
 * @spec SM-2-visibility — the same access as the sale; a locked sale sends visitors to unlock it.
 * @spec IMG-public-approved
 */
export const load: PageServerLoad = async (event) => {
	const { sale, access, isSeller } = await loadSaleForViewer(event, event.params.slug);
	if (access === "locked") redirect(303, `/s/${sale.slug}`);
	const item = await findItem(db(), sale.id, event.params.itemId);
	if (!item) error(404, "No such item");
	const photos = (await photosByItem(db(), [item.id], isSeller ? "visible" : "approved")).get(item.id) ?? [];
	return {
		header: saleHeader(sale),
		body: saleBody(sale),
		item: publicItem(item),
		photos: photos.map((p) => ({ id: p.id, url: `/api/images/${p.id}`, width: p.width, height: p.height })),
	};
};
