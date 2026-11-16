import { FREE_ACTIVE_SALE_CAP, FREE_ITEM_CAP } from "@claimsale/core";
import { db } from "#lib/server/context.ts";
import { countActiveSales, listSellerSales } from "#lib/server/sales.ts";
import { requireSeller } from "#lib/server/sell.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const [sales, active] = await Promise.all([
		listSellerSales(db(), seller.id),
		countActiveSales(db(), seller.id),
	]);
	return {
		sales,
		tier: seller.tier,
		active,
		caps: { sales: FREE_ACTIVE_SALE_CAP, items: FREE_ITEM_CAP },
	};
};
