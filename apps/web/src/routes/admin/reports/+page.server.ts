import { fail, type RequestEvent } from "@sveltejs/kit";
import { requireAdmin } from "#lib/server/admin.ts";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { closeReport, openReports } from "#lib/server/moderation.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Reports of users, sales, items and messages (ADMIN-report-queue). */
export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { reports: await openReports(db()) };
};

async function close(event: RequestEvent, status: "resolved" | "dismissed") {
	const admin = requireAdmin(event);
	const data = await event.request.formData();
	const result = await closeReport(
		db(),
		{ reportId: field(data, "reportId"), adminId: admin.id, status, note: field(data, "note") },
		Date.now(),
	);
	if (!result.ok) return fail(400, { message: result.error.message });
	return { message: status === "resolved" ? "Report resolved." : "Report dismissed." };
}

export const actions: Actions = {
	/** @spec ADMIN-report-queue */
	resolve: (event) => close(event, "resolved"),
	/** @spec ADMIN-report-queue */
	dismiss: (event) => close(event, "dismissed"),
};
