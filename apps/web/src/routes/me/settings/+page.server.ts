import { validateDisplayName, validateFacebookUrl, validateHandle } from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { auth, db } from "#lib/server/context.ts";
import { type FormErrors, authErrorMessage, field, fieldError } from "#lib/server/forms.ts";
import { isHandleAvailable, isUniqueViolation, updateProfile } from "#lib/server/users.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	const user = locals.user;
	return {
		profile: {
			email: user.email,
			emailVerified: user.emailVerified,
			displayName: user.name,
			handle: user.handle ?? "",
			fbProfileUrl: user.fbProfileUrl ?? "",
			ageAttested: user.ageAttested ?? null,
		},
	};
};

export const actions: Actions = {
	profile: async ({ request, locals }) => {
		if (!locals.user) redirect(303, "/login");
		const data = await request.formData();
		const values = {
			displayName: field(data, "displayName"),
			handle: field(data, "handle"),
			fbProfileUrl: field(data, "fbProfileUrl"),
		};
		const errors: FormErrors = {};
		const displayName = validateDisplayName(values.displayName);
		if (!displayName.ok) errors.displayName = displayName.message;
		const handle = validateHandle(values.handle);
		if (!handle.ok) errors.handle = handle.message;
		const fb = validateFacebookUrl(values.fbProfileUrl);
		if (!fb.ok) errors.fbProfileUrl = fb.message;
		if (handle.ok && !(await isHandleAvailable(db(), handle.value, locals.user.id)))
			errors.handle = "That handle is taken";
		if (!displayName.ok || !handle.ok || !fb.ok || Object.keys(errors).length > 0) {
			return fail(400, { action: "profile" as const, values, errors });
		}
		try {
			await updateProfile(
				db(),
				locals.user.id,
				{ displayName: displayName.value, handle: handle.value, fbProfileUrl: fb.value },
				new Date(),
			);
		} catch (error) {
			if (isUniqueViolation(error))
				return fail(409, {
					action: "profile" as const,
					values,
					errors: fieldError("handle", "That handle is taken"),
				});
			throw error;
		}
		return { action: "profile" as const, saved: true };
	},

	verify: async ({ request, locals, url }) => {
		if (!locals.user) redirect(303, "/login");
		try {
			await auth(url.origin).api.sendVerificationEmail({
				body: { email: locals.user.email, callbackURL: "/me/settings?verified=1" },
				headers: request.headers,
			});
		} catch (error) {
			return fail(400, { action: "verify" as const, message: authErrorMessage(error) });
		}
		return { action: "verify" as const, sent: true };
	},
};
