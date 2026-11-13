import { fail } from "@sveltejs/kit";
import { auth } from "#lib/server/context.ts";
import { authErrorMessage, field, isApiError } from "#lib/server/forms.ts";
import type { Actions } from "./$types";

export const actions: Actions = {
	default: async ({ request, url }) => {
		const email = field(await request.formData(), "email").trim();
		try {
			await auth(url.origin).api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
		} catch (error) {
			// Only rate limits are shown; anything else would reveal whether the account exists.
			if (isApiError(error) && error.statusCode === 429)
				return fail(429, { email, message: authErrorMessage(error) });
		}
		return { email, sent: true };
	},
};
