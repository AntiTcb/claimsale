import { fail, type RequestEvent } from "@sveltejs/kit";
import { requireAdmin } from "#lib/server/admin.ts";
import { db } from "#lib/server/context.ts";
import {
	decideWindowRequest,
	pendingWindowRequests,
	resetWindowCap,
	sellerWindow,
} from "#lib/server/decision-window.ts";
import { field } from "#lib/server/forms.ts";
import { banUser, findUsers, grantPro, revokePro, unbanUser, userDetail } from "#lib/server/moderation.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Find an account; ban or unban it; grant or revoke Pro; answer decision-window requests (ADMIN-ban, ADMIN-pro-grant, ADMIN-decision-window). */
export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const q = event.url.searchParams.get("q") ?? "";
	const id = event.url.searchParams.get("id");
	const [results, detail, window, windowRequests] = await Promise.all([
		findUsers(db(), q),
		id ? userDetail(db(), id) : null,
		id ? sellerWindow(db(), id) : null,
		pendingWindowRequests(db()),
	]);
	return { q, results, detail, window, windowRequests };
};

const DAY = 86_400_000;

async function act(
	event: RequestEvent,
	run: (
		adminId: string,
		userId: string,
		data: FormData,
		now: number,
	) => Promise<{ ok: boolean; error?: { message: string } }>,
	done: string,
) {
	const admin = requireAdmin(event);
	const data = await event.request.formData();
	const userId = field(data, "userId");
	const result = await run(admin.id, userId, data, Date.now());
	if (!result.ok) return fail(400, { message: result.error?.message ?? "That didn't work." });
	return { message: done };
}

export const actions: Actions = {
	/** @spec ADMIN-ban */
	ban: (event) =>
		act(
			event,
			(adminId, userId, data, now) => banUser(db(), { userId, adminId, reason: field(data, "reason") }, now),
			"Account banned; its sessions have ended.",
		),
	/** @spec ADMIN-ban */
	unban: (event) =>
		act(
			event,
			(adminId, userId, _data, now) => unbanUser(db(), { userId, adminId }, now),
			"Account unbanned.",
		),
	/** @spec ADMIN-pro-grant */
	grant: (event) =>
		act(
			event,
			(adminId, userId, data, now) => {
				const days = field(data, "days").trim();
				const n = days === "" ? null : Number(days);
				if (n !== null && (!Number.isInteger(n) || n < 1 || n > 3650)) {
					return Promise.resolve({
						ok: false,
						error: { message: "Enter whole days from 1 to 3650, or leave it empty" },
					});
				}
				return grantPro(
					db(),
					{ userId, adminId, planId: field(data, "planId"), until: n === null ? null : now + n * DAY },
					now,
				);
			},
			"Pro granted.",
		),
	/** @spec ADMIN-pro-grant */
	revoke: (event) =>
		act(
			event,
			(adminId, userId, data, now) =>
				revokePro(db(), { userId, adminId, planId: field(data, "planId") }, now),
			"Grant revoked.",
		),
	/** @spec ADMIN-decision-window */
	approveWindow: (event) =>
		act(
			event,
			(adminId, userId, _data, now) => decideWindowRequest(db(), { userId, adminId, approve: true }, now),
			"Longer decision window approved.",
		),
	/** @spec ADMIN-decision-window */
	declineWindow: (event) =>
		act(
			event,
			(adminId, userId, _data, now) => decideWindowRequest(db(), { userId, adminId, approve: false }, now),
			"Request declined.",
		),
	/** @spec ADMIN-decision-window */
	resetWindow: (event) =>
		act(
			event,
			(adminId, userId, _data, now) => resetWindowCap(db(), { userId, adminId }, now),
			"Decision window cap reset to 7 days.",
		),
};
