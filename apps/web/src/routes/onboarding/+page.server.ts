import { validateAge, validateDisplayName, validateHandle } from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { type FormErrors, field, fieldError } from "#lib/server/forms.ts";
import { needsOnboarding, safeRedirect } from "#lib/server/onboarding.ts";
import { completeIdentity, isHandleAvailable, isUniqueViolation } from "#lib/server/users.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Finishes accounts made through Discord or a magic link: handle, name and age (D38). */
export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeRedirect(url.searchParams.get("next"));
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent("/onboarding")}`);
	if (!needsOnboarding(locals.user)) redirect(303, next);
	return {
		next,
		taken: url.searchParams.get("taken") === "1",
		displayName: locals.user.name,
		handle: locals.user.handle ?? "",
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) redirect(303, "/login");
		const data = await request.formData();
		const values = {
			displayName: field(data, "displayName"),
			handle: field(data, "handle"),
			age: field(data, "age"),
		};
		const next = safeRedirect(field(data, "next"));
		const errors: FormErrors = {};
		const displayName = validateDisplayName(values.displayName);
		if (!displayName.ok) errors.displayName = displayName.message;
		const handle = validateHandle(values.handle);
		if (!handle.ok) errors.handle = handle.message;
		const age = validateAge(values.age, data.get("parentalConsent"));
		if (!age.ok) errors.age = age.message;
		if (handle.ok && !(await isHandleAvailable(db(), handle.value, locals.user.id)))
			errors.handle = "That handle is taken";
		if (!displayName.ok || !handle.ok || !age.ok || Object.keys(errors).length > 0)
			return fail(400, { values, errors });
		try {
			await completeIdentity(
				db(),
				locals.user.id,
				{ handle: handle.value, displayName: displayName.value, ageAttested: age.value },
				new Date(),
			);
		} catch (error) {
			if (isUniqueViolation(error))
				return fail(409, { values, errors: fieldError("handle", "That handle is taken") });
			throw error;
		}
		return redirect(303, next);
	},
};
