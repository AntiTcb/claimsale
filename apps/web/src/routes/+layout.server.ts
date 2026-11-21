import { db } from "#lib/server/context.ts";
import { unreadCount } from "#lib/server/notifications.ts";
import { isTimeZone, TIME_ZONE_COOKIE } from "#lib/dates.ts";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, depends, cookies }) => {
	const zone = cookies.get(TIME_ZONE_COOKIE);
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
		// The viewer's time zone, so dates render in it on the server (the browser sets the cookie).
		timeZone: isTimeZone(zone) ? zone : null,
	};
};
