import { fail } from "@sveltejs/kit";
import { db, invoiceEngine } from "#lib/server/context.ts";
import { saleBuyers } from "#lib/server/invoices.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Per-buyer rollup → invoices (PLAN §7). Sending goes through the engine (D49). */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	return { buyers: await saleBuyers(db(), sale.id) };
};

export const actions: Actions = {
	/** @spec SM-6-send-after-close — "Send all" sends every draft once the sale has closed. */
	sendAll: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const result = await invoiceEngine().sendAll(sale.id, seller.id);
		if (!result.ok) return fail(400, { message: result.error.message });
		return { sent: result.value.sent };
	},

	close: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const result = await invoiceEngine().closeSale(sale.id, seller.id);
		if (!result.ok) return fail(400, { message: result.error.message });
		return { closed: true };
	},
};
