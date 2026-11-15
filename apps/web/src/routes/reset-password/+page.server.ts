import { PASSWORD_MAX, PASSWORD_MIN } from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { auth } from "#lib/server/context.ts";
import { authErrorMessage, field } from "#lib/server/forms.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Better Auth redirects here with ?token=… (or ?error=INVALID_TOKEN). */
export const load: PageServerLoad = ({ url }) => ({
	token: url.searchParams.get("token") ?? "",
	invalid: url.searchParams.get("error") === "INVALID_TOKEN" || !url.searchParams.get("token"),
});

export const actions: Actions = {
	default: async ({ request, url }) => {
		const data = await request.formData();
		const password = field(data, "password");
		if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
			return fail(400, { message: `Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters` });
		}
		try {
			await auth(url.origin).api.resetPassword({
				body: { newPassword: password, token: field(data, "token") },
			});
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}
		return redirect(303, "/login?reset=1");
	},
};
