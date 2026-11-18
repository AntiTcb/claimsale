import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES } from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import {
	listNotifications,
	markAllRead,
	openNotification,
	readEmailOff,
	saveEmailPreferences,
} from "#lib/server/notifications.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** The bell's page: notifications, newest first, and which ones are also emailed (WS-K). */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const [notifications, emailOff] = await Promise.all([
		listNotifications(db(), user.id),
		readEmailOff(db(), user.id),
	]);
	return {
		notifications,
		emailVerified: user.emailVerified,
		categories: NOTIFICATION_CATEGORIES.map((id) => ({
			id,
			...CATEGORY_LABELS[id],
			email: !emailOff.has(id),
		})),
	};
};

export const actions: Actions = {
	/** Opens one notification: marks it read and goes where it points. */
	open: async (event) => {
		const user = requireUser(event);
		const path = await openNotification(
			db(),
			user.id,
			field(await event.request.formData(), "id"),
			Date.now(),
		);
		if (!path) return fail(404, { action: "open" as const, message: "That notification is gone" });
		return redirect(303, path);
	},

	readAll: async (event) => {
		const user = requireUser(event);
		await markAllRead(db(), user.id, Date.now());
		return { action: "readAll" as const, done: true };
	},

	/** @spec NOTIF-preferences */
	preferences: async (event) => {
		const user = requireUser(event);
		const data = await event.request.formData();
		await saveEmailPreferences(
			db(),
			user.id,
			data.getAll("email").filter((v): v is string => typeof v === "string"),
			Date.now(),
		);
		return { action: "preferences" as const, saved: true };
	},
};
