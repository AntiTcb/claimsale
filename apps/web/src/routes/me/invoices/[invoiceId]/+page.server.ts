import { error, fail } from "@sveltejs/kit";
import { listAddresses } from "#lib/server/addresses.ts";
import { db, invoiceEngine } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { buyerInvoice } from "#lib/server/invoices.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The buyer's invoice (STATE_MACHINES §6): the seller's payment handles, a shipping
 * option and an address from the address book, "I've paid" with an optional reference,
 * and "I received it" once shipped. Both go through the sale engine.
 */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const invoice = await buyerInvoice(db(), user.id, event.params.invoiceId, Date.now());
	if (!invoice) error(404, "No such invoice");
	const addresses = await listAddresses(db(), user.id);
	return {
		invoice,
		addresses: addresses.map((a) => ({
			id: a.id,
			label: `${a.name}, ${a.line1}, ${a.city} ${a.region}`,
			isDefault: a.isDefault,
		})),
	};
};

export const actions: Actions = {
	/**
	 * @spec SM-6-paid-flow
	 * @spec SM-6-address-snapshot
	 */
	pay: async (event) => {
		const user = requireUser(event);
		const invoice = await buyerInvoice(db(), user.id, event.params.invoiceId, Date.now());
		if (!invoice) error(404, "No such invoice");
		const data = await event.request.formData();
		const values = {
			shippingOptionId: field(data, "shippingOptionId"),
			addressId: field(data, "addressId"),
			paymentRef: field(data, "paymentRef").trim().slice(0, 200),
		};
		if (values.shippingOptionId === "")
			return fail(400, { action: "pay", values, message: "Choose a shipping option" });
		if (values.addressId === "")
			return fail(400, { action: "pay", values, message: "Choose a shipping address" });
		const result = await invoiceEngine().markPaid({
			saleId: invoice.saleId,
			invoiceId: invoice.id,
			buyerId: user.id,
			shippingOptionId: values.shippingOptionId,
			addressId: values.addressId,
			paymentRef: values.paymentRef || null,
		});
		if (!result.ok) return fail(400, { action: "pay", values, message: result.error.message });
		return { action: "pay", done: true as const };
	},

	/** @spec SM-6-autocomplete — the buyer confirms receipt; feedback opens. */
	received: async (event) => {
		const user = requireUser(event);
		const invoice = await buyerInvoice(db(), user.id, event.params.invoiceId, Date.now());
		if (!invoice) error(404, "No such invoice");
		const result = await invoiceEngine().complete(invoice.saleId, invoice.id, user.id);
		if (!result.ok) return fail(400, { action: "received", message: result.error.message });
		return { action: "received", done: true as const };
	},
};
