import { fail, redirect } from "@sveltejs/kit";
import { readTerms, validateTerms } from "#lib/listing-input.ts";
import { db } from "#lib/server/context.ts";
import { requestLongerWindow, sellerWindow } from "#lib/server/decision-window.ts";
import { field } from "#lib/server/forms.ts";
import { updateTerms } from "#lib/server/sales.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Step 2 of the wizard (and editable later): payment, deadline, shipping and rules. */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	return {
		terms: readTerms(sale.terms),
		window: await sellerWindow(db(), seller.id),
		wizard: event.url.searchParams.get("wizard") === "1",
	};
};

export const actions: Actions = {
	/** SvelteKit doesn't allow a default action next to named ones, so the terms form posts to `?/save`. */
	save: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const data = await event.request.formData();
		const result = validateTerms(
			{
				paymentMethods: data.getAll("paymentMethods").filter((v): v is string => typeof v === "string"),
				paymentDeadlineHours: field(data, "paymentDeadlineHours"),
				shipsTo: field(data, "shipsTo"),
				rulesMd: field(data, "rulesMd"),
				offerVisibility: field(data, "offerVisibility"),
				reviewEveryClaim: data.get("reviewEveryClaim") === "on",
				allowBackupOffers: data.get("allowBackupOffers") === "on",
				decisionWindowHours: field(data, "decisionWindowHours"),
				minAccountAgeDays: field(data, "minAccountAgeDays"),
				confirmClaims: data.get("confirmClaims") === "on",
			},
			seller.tier === "pro",
			(await sellerWindow(db(), seller.id)).capHours,
		);
		if (!result.ok) return fail(400, { errors: "errors" in result ? result.errors : {} });
		const saved = await updateTerms(db(), seller, sale.id, result.value, Date.now());
		if (!saved.ok) return fail(400, { errors: { rulesMd: saved.error.message } });
		if (event.url.searchParams.get("wizard") === "1") redirect(303, `/sell/${sale.id}/items?wizard=1`);
		return { saved: true };
	},
	/** @spec ADMIN-decision-window — a Pro seller asks an admin for a longer cap (D68). */
	requestWindow: async (event) => {
		const seller = await requireSeller(event);
		await requireOwnSale(seller.id, event.params.saleId);
		const data = await event.request.formData();
		const result = await requestLongerWindow(
			db(),
			seller,
			{ hours: field(data, "hours"), reason: field(data, "reason") },
			Date.now(),
		);
		if (!result.ok) return fail(400, { windowRequestError: result.error.message });
		return { windowRequested: true };
	},
};
