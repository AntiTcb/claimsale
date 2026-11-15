import { fail } from "@sveltejs/kit";
import {
	addAddress,
	deleteAddress,
	listAddresses,
	setDefaultAddress,
	validateAddress,
} from "#lib/server/addresses.ts";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** The buyer's address book; an address is picked when paying an invoice (PLAN §3 "Invoice"). */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const rows = await listAddresses(db(), user.id);
	return {
		addresses: rows.map((a) => ({
			id: a.id,
			name: a.name,
			line1: a.line1,
			line2: a.line2,
			city: a.city,
			region: a.region,
			postalCode: a.postalCode,
			isDefault: a.isDefault,
		})),
	};
};

export const actions: Actions = {
	add: async (event) => {
		const user = requireUser(event);
		const data = await event.request.formData();
		const values = {
			name: field(data, "name"),
			line1: field(data, "line1"),
			line2: field(data, "line2"),
			city: field(data, "city"),
			region: field(data, "region"),
			postalCode: field(data, "postalCode"),
		};
		const valid = validateAddress(values);
		if (!valid.ok) return fail(400, { action: "add" as const, values, errors: valid.errors });
		const added = await addAddress(db(), user.id, valid.value, data.get("isDefault") === "on", Date.now());
		if (!added.ok)
			return fail(400, { action: "add" as const, values, errors: { name: added.error.message } });
		return { action: "add" as const, added: true };
	},

	makeDefault: async (event) => {
		const user = requireUser(event);
		const result = await setDefaultAddress(
			db(),
			user.id,
			field(await event.request.formData(), "id"),
			Date.now(),
		);
		if (!result.ok) return fail(404, { action: "makeDefault" as const, message: result.error.message });
		return { action: "makeDefault" as const, done: true };
	},

	delete: async (event) => {
		const user = requireUser(event);
		const result = await deleteAddress(
			db(),
			user.id,
			field(await event.request.formData(), "id"),
			Date.now(),
		);
		if (!result.ok) return fail(404, { action: "delete" as const, message: result.error.message });
		return { action: "delete" as const, done: true };
	},
};
