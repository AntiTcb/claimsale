import { checkImportTarget, FREE_ITEM_CAP } from "@claimsale/core";
import { defaultMarketPercent } from "#lib/server/catalog.ts";
import { db } from "#lib/server/context.ts";
import { toExisting } from "#lib/server/import.ts";
import { listItems } from "#lib/server/items.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { PageServerLoad } from "./$types";

/** /sell/[saleId]/import: upload, map, preview, confirm, results (PLAN §3c.1). */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	const target = checkImportTarget(sale.status);
	const existing = await listItems(db(), sale.id);
	return {
		importable: target.ok ? null : target.error.message,
		itemCap: seller.tier === "free" ? FREE_ITEM_CAP : null,
		/** For the preview's create / update counts (the server plans again on apply). */
		existing: existing.map(toExisting),
		defaultPercent: await defaultMarketPercent(db(), seller.id),
	};
};
