import { fail } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import {
	readShippingSettings,
	saveShippingSettings,
	validateShippingSettings,
} from "#lib/server/sale-shipping.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import { PAYMENT_METHODS } from "#lib/listing-input.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Shipping menu (D15), the invoice switches (D49, D13) and payment handles. */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	return { settings: await readShippingSettings(db(), seller.id, sale) };
};

export const actions: Actions = {
	default: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const data = await event.request.formData();
		const strings = (name: string) => data.getAll(name).map((v) => (typeof v === "string" ? v : ""));
		const ids = strings("optionId");
		const labels = strings("optionLabel");
		const prices = strings("optionPrice");
		const tracked = new Set(strings("optionTracked"));
		const options = labels.map((label, i) => ({
			id: ids[i] ?? "",
			label,
			price: prices[i] ?? "",
			// Checkboxes post the row's index, since unchecked boxes post nothing.
			tracked: tracked.has(String(i)),
		}));
		const handles = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.id, field(data, `handle_${m.id}`)]));
		const result = validateShippingSettings({
			options,
			autoSendAtClose: data.get("autoSendAtClose") === "on",
			autoRescindOverdue: data.get("autoRescindOverdue") === "on",
			handles,
		});
		if (!result.ok) return fail(400, { options, handles, errors: result.error });
		const saved = await saveShippingSettings(db(), seller.id, sale.id, result.value, Date.now());
		if (!saved.ok) return fail(400, { options, handles, message: saved.error.message });
		return { saved: true };
	},
};
