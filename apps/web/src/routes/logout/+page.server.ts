import { redirect } from "@sveltejs/kit";
import { auth } from "#lib/server/context.ts";
import { forwardCookies } from "#lib/server/cookies.ts";
import type { Actions, PageServerLoad } from "./$types";

// Signing out is a POST (from the header); a GET just goes home.
export const load: PageServerLoad = () => redirect(303, "/");

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		try {
			const result = await auth(url.origin).api.signOut({ headers: request.headers, returnHeaders: true });
			forwardCookies(result.headers, cookies);
		} catch {
			// No session: nothing to sign out of.
		}
		redirect(303, "/");
	},
};
