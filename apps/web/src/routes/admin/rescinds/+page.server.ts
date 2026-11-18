import { fail } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { requireAdmin, resolveFlag } from "#lib/server/admin.ts";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { overturnedFlags, rescindQueue } from "#lib/server/moderation.ts";
import { resolveDispute } from "#lib/server/rescinds.ts";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Rescind disputes (STATE_MACHINES §4.3.1): contested rescinds, disputed mutual
 * agreements and suspected fraud held for review, plus sellers the abuse guard flagged.
 */
export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const [queue, flags] = await Promise.all([rescindQueue(db()), overturnedFlags(db())]);
	return { queue, flags };
};

export const actions: Actions = {
	/** @spec SM-4.3.1-contest — the admin resolves (and may re-attribute) a disputed rescind. */
	resolve: async (event) => {
		const admin = requireAdmin(event);
		const data = await event.request.formData();
		const result = await resolveDispute(db(), env.ENGINE, {
			rescindId: field(data, "rescindId"),
			adminId: admin.id,
			fault: field(data, "fault"),
			note: field(data, "note"),
		});
		if (!result.ok)
			return fail(result.error.code === "engine_unavailable" ? 503 : 400, { message: result.error.message });
		return { message: "Rescind resolved." };
	},
	/** @spec SM-4.3.1-abuse-guard — the admin has looked at a flagged seller. */
	resolveFlag: async (event) => {
		const admin = requireAdmin(event);
		const done = await resolveFlag(
			db(),
			field(await event.request.formData(), "flagId"),
			admin.id,
			Date.now(),
		);
		return { message: done ? "Flag resolved." : "That flag was already resolved." };
	},
};
