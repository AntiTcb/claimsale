import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { LayoutServerLoad } from "./$types";

/** Every /sell/[saleId] page: the seller's own sale, or 404. */
export const load: LayoutServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	return {
		tier: seller.tier,
		sale: {
			id: sale.id,
			slug: sale.slug,
			title: sale.title,
			descriptionMd: sale.descriptionMd,
			status: sale.status,
			visibility: sale.visibility,
			liveAt: sale.liveAt,
			closesAt: sale.closesAt,
		},
	};
};
