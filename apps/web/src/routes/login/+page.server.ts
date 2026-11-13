import { fail, redirect } from "@sveltejs/kit";
import { auth, discordConfigured } from "#lib/server/context.ts";
import { forwardCookies } from "#lib/server/cookies.ts";
import { authErrorMessage, field } from "#lib/server/forms.ts";
import { safeRedirect } from "#lib/server/onboarding.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeRedirect(url.searchParams.get("next"));
	if (locals.user) redirect(303, next);
	return { discord: discordConfigured(), next };
};

export const actions: Actions = {
	password: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const email = field(data, "email").trim();
		const next = safeRedirect(field(data, "next"));
		try {
			const result = await auth(url.origin).api.signInEmail({
				body: { email, password: field(data, "password") },
				headers: request.headers,
				returnHeaders: true,
			});
			forwardCookies(result.headers, cookies);
		} catch (error) {
			return fail(400, { action: "password" as const, email, message: authErrorMessage(error) });
		}
		return redirect(303, next);
	},

	magic: async ({ request, url }) => {
		const data = await request.formData();
		const email = field(data, "email").trim();
		const next = safeRedirect(field(data, "next"));
		try {
			await auth(url.origin).api.signInMagicLink({
				body: { email, callbackURL: next, newUserCallbackURL: "/onboarding" },
				headers: request.headers,
			});
		} catch (error) {
			return fail(400, { action: "magic" as const, email, message: authErrorMessage(error) });
		}
		// Same answer whether or not the address has an account.
		return { action: "magic" as const, email, sent: true };
	},

	discord: async ({ request, cookies, url }) => {
		if (!discordConfigured())
			return fail(404, { action: "discord" as const, message: "Discord sign-in isn't set up" });
		const next = safeRedirect(field(await request.formData(), "next"));
		const result = await auth(url.origin).api.signInSocial({
			body: { provider: "discord", callbackURL: next, newUserCallbackURL: "/onboarding" },
			headers: request.headers,
			returnHeaders: true,
		});
		forwardCookies(result.headers, cookies);
		if (!result.response.url)
			return fail(500, { action: "discord" as const, message: "Discord sign-in failed" });
		return redirect(303, result.response.url);
	},
};
