import { db } from "#lib/server/context.ts";
import { unreadCount } from "#lib/server/notifications.ts";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	// The bell's count; pages that read notifications invalidate it (WS-K).
	depends("app:notifications");
	return {
		user: locals.user
			? {
					handle: locals.user.handle ?? null,
					displayName: locals.user.name,
					emailVerified: locals.user.emailVerified,
				}
			: null,
		unreadNotifications: locals.user ? await unreadCount(db(), locals.user.id) : 0,
	};
};
