import { db } from "#lib/server/context.ts";
import { listBuyerInvoices } from "#lib/server/invoices.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { PageServerLoad } from "./$types";

/** The buyer's invoices across sales; drafts are the running total of a sale still open (D53). */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	return { invoices: await listBuyerInvoices(db(), user.id) };
};
