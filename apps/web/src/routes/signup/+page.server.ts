import {
	PASSWORD_MAX,
	PASSWORD_MIN,
	validateAge,
	validateDisplayName,
	validateHandle,
} from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { auth, db, turnstile } from "#lib/server/context.ts";
import { forwardCookies } from "#lib/server/cookies.ts";
import { type FormErrors, field, formError } from "#lib/server/forms.ts";
import { signUpWithCaptcha } from "#lib/server/signup.ts";
import { TURNSTILE_FIELD } from "#lib/server/turnstile.ts";
import { completeIdentity, isHandleAvailable, isUniqueViolation } from "#lib/server/users.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, "/");
	// Without Turnstile there is no email sign-up (S41); the page says so.
	return { turnstileSiteKey: turnstile()?.siteKey ?? null };
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

		const result = await signUpWithCaptcha(
			auth(url.origin),
			request,
			url.origin,
			{ name: displayName.value, email: values.email, password, callbackURL: "/?verified=1" },
			field(data, TURNSTILE_FIELD),
		);
		if (!result.ok) return fail(400, { values, errors: formError(result.message) });
		forwardCookies(result.headers, cookies);

		try {
			await completeIdentity(
				db(),
				result.userId,
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
