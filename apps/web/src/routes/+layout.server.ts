import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => ({
	user: locals.user
		? {
				handle: locals.user.handle ?? null,
				displayName: locals.user.name,
				emailVerified: locals.user.emailVerified,
			}
		: null,
});
