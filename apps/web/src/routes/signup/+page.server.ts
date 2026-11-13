import {
	PASSWORD_MAX,
	PASSWORD_MIN,
	validateAge,
	validateDisplayName,
	validateHandle,
} from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { auth, db } from "#lib/server/context.ts";
import { forwardCookies } from "#lib/server/cookies.ts";
import { type FormErrors, authErrorMessage, field, formError } from "#lib/server/forms.ts";
import { completeIdentity, isHandleAvailable, isUniqueViolation } from "#lib/server/users.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, "/");
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const values = {
			displayName: field(data, "displayName"),
			handle: field(data, "handle"),
			email: field(data, "email").trim(),
			age: field(data, "age"),
		};
		const password = field(data, "password");
		const errors: FormErrors = {};

		const displayName = validateDisplayName(values.displayName);
		if (!displayName.ok) errors.displayName = displayName.message;
		const handle = validateHandle(values.handle);
		if (!handle.ok) errors.handle = handle.message;
		const age = validateAge(values.age, data.get("parentalConsent"));
		if (!age.ok) errors.age = age.message;
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = "Enter a valid email address";
		if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
			errors.password = `Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters`;
		}
		if (handle.ok && !(await isHandleAvailable(db(), handle.value))) errors.handle = "That handle is taken";
		if (!displayName.ok || !handle.ok || !age.ok || Object.keys(errors).length > 0) {
			return fail(400, { values, errors });
		}

		let userId: string;
		try {
			const result = await auth(url.origin).api.signUpEmail({
				body: { name: displayName.value, email: values.email, password, callbackURL: "/?verified=1" },
				headers: request.headers,
				returnHeaders: true,
			});
			forwardCookies(result.headers, cookies);
			userId = result.response.user.id;
		} catch (error) {
			return fail(400, { values, errors: formError(authErrorMessage(error)) });
		}

		try {
			await completeIdentity(
				db(),
				userId,
				{ handle: handle.value, displayName: displayName.value, ageAttested: age.value },
				new Date(),
			);
		} catch (error) {
			// Someone took the handle a moment ago: the account exists, so finish on onboarding.
			if (isUniqueViolation(error)) redirect(303, "/onboarding?taken=1");
			throw error;
		}
		return redirect(303, "/?welcome=1");
	},
};
