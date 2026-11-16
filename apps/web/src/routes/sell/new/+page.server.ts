import { fail, redirect } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { createDraft, setPrivateAccess } from "#lib/server/sales.ts";
import { readDetailsForm, requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Step 1 of the new-sale wizard: details. Creates the draft, then goes to terms. */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	return { canUsePrivate: seller.tier === "pro" };
};

export const actions: Actions = {
	default: async (event) => {
		const seller = await requireSeller(event);
		const form = await readDetailsForm(await event.request.formData(), { hasPassword: false });
		if (!form.ok) return fail(400, { values: form.values, errors: form.errors });
		const now = Date.now();
		const created = await createDraft(db(), seller, form.details, now);
		if (!created.ok) return fail(403, { values: form.values, errors: { visibility: created.error.message } });
		if (form.access) await setPrivateAccess(db(), created.value.id, form.access, now);
		return redirect(303, `/sell/${created.value.id}/terms?wizard=1`);
	},
};
