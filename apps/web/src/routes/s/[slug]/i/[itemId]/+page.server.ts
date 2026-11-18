import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { db } from "#lib/server/context.ts";
import { photosByItem } from "#lib/server/images.ts";
import { findItem } from "#lib/server/items.ts";
import { liveSnapshotFor } from "#lib/server/live.ts";
import { loadSaleForViewer, publicItem, saleBody, saleHeader } from "#lib/server/sale-view.ts";
import type { PageServerLoad } from "./$types";

/**
 * Item detail, with claim, offer and the buyer's own entry (WS-M2): the same live snapshot
 * as the sale page, for this viewer.
 *
 * @spec SM-2-visibility — the same access as the sale; a locked sale sends visitors to unlock it.
 * @spec IMG-public-approved
 */
export const load: PageServerLoad = async (event) => {
	const { sale, access, isSeller } = await loadSaleForViewer(event, event.params.slug);
	if (access === "locked") redirect(303, `/s/${sale.slug}`);
	const item = await findItem(db(), sale.id, event.params.itemId);
	if (!item) error(404, "No such item");
	const viewerId = event.locals.user?.id ?? null;
	const [photoMap, live] = await Promise.all([
		photosByItem(db(), [item.id], isSeller ? "visible" : "approved"),
		liveSnapshotFor(env.ENGINE, sale.id, viewerId),
	]);
	const photos = photoMap.get(item.id) ?? [];
	return {
		saleId: sale.id,
		live,
		isSeller,
		signedIn: viewerId !== null,
		header: saleHeader(sale),
		body: saleBody(sale),
		item: publicItem(item),
		photos: photos.map((p) => ({ id: p.id, url: `/api/images/${p.id}`, width: p.width, height: p.height })),
	};
};
