import { REPORT_REASON_LABELS, REPORT_REASONS } from "@claimsale/core";
import { fail } from "@sveltejs/kit";
import { requireAdmin } from "#lib/server/admin.ts";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { closeReport, openReports } from "#lib/server/messaging.ts";
import type { Actions, PageServerLoad } from "./$types";

const reasonLabels: Readonly<Record<string, string>> = REPORT_REASON_LABELS;

/** The admin queue for reports (PLAN §9; MSG-report). The layout already checked the role. */
export const load: PageServerLoad = async () => {
	const reports = await openReports(db());
	return {
		reports: reports.map((r) => ({ ...r, reasonLabel: reasonLabels[r.reason] ?? r.reason })),
		reasons: REPORT_REASONS,
	};
};

export const actions: Actions = {
	close: async (event) => {
		const admin = requireAdmin(event);
		const data = await event.request.formData();
		const status = field(data, "status") === "resolved" ? "resolved" : "dismissed";
		const closed = await closeReport(db(), field(data, "id"), admin.id, status, Date.now());
		if (!closed) return fail(409, { message: "That report was already closed" });
		return { closed: status };
	},
};
