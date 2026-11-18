import { db } from "#lib/server/context.ts";
import { importableInvoices } from "#lib/server/invoices.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { PageServerLoad } from "./$types";

/** Tracking re-import (PLAN §3c.3): the sale's sent invoices, to match the file against in the browser. */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	return { invoices: await importableInvoices(db(), sale.id) };
};
