import { fail } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { heldPhotos, openFlags, requireAdmin, resolveFlag } from "#lib/server/admin.ts";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { reviewHeldPhoto } from "#lib/server/photo-checks.ts";
import { runExit } from "#lib/server/runtime.ts";
import { Exit } from "effect";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The admin queue: photos held for review (IMG-dup-review) and accounts flagged for
 * repeated duplicate photos (IMG-repeat-offender).
 */
export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	const [photos, flags] = await Promise.all([heldPhotos(db()), openFlags(db())]);
	return { photos, flags };
};

async function review(event: Parameters<Actions[string]>[0], decision: "approved" | "rejected") {
	const admin = requireAdmin(event);
	const imageId = field(await event.request.formData(), "imageId");
	if (!imageId) return fail(400, { message: "Pick a photo" });
	const exit = await runExit(
		"web.admin.review_photo",
		reviewHeldPhoto(env.ENGINE, { imageId, adminId: admin.id, decision }),
	);
	if (Exit.isFailure(exit)) return fail(502, { message: "The decision wasn't saved. Try again." });
	return exit.value
		? { message: decision === "approved" ? "Photo approved." : "Photo rejected." }
		: { message: "That photo was already decided." };
}

export const actions: Actions = {
	/** @spec IMG-dup-review — an admin releases a held photo. */
	approve: (event) => review(event, "approved"),
	/** @spec IMG-dup-review — an admin rejects a held photo (it counts toward IMG-repeat-offender). */
	reject: (event) => review(event, "rejected"),
	/** @spec IMG-repeat-offender — the admin has looked at a flagged account. */
	resolveFlag: async (event) => {
		const admin = requireAdmin(event);
		const flagId = field(await event.request.formData(), "flagId");
		const done = await resolveFlag(db(), flagId, admin.id, Date.now());
		return { message: done ? "Flag resolved." : "That flag was already resolved." };
	},
};
