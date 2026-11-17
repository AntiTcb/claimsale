import { fail, type RequestEvent } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { answerAsBuyer, buyerRescinds, contestAsBuyer } from "#lib/server/rescinds.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/**
 * Wins a seller rescinded from you (STATE_MACHINES §4.3.1): the reason and the seller's
 * explanation, a contest within 7 days, and the agree / dispute prompt for a mutual agreement.
 */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const now = Date.now();
	return { rescinds: await buyerRescinds(db(), user.id, now), now };
};

const done = (result: Awaited<ReturnType<typeof contestAsBuyer>>, rescindId: string, message: string) =>
	result.ok
		? { rescindId, message }
		: fail(result.error.code === "engine_unavailable" ? 503 : 400, {
				rescindId,
				error: result.error.message,
			});

async function answer(event: RequestEvent, agree: boolean) {
	const user = requireUser(event);
	const rescindId = field(await event.request.formData(), "rescindId");
	const result = await answerAsBuyer(db(), env.ENGINE, { rescindId, buyerId: user.id, agree });
	return done(
		result,
		rescindId,
		agree
			? "Thanks. It counts for no one."
			: "Sent to an admin, who will decide. Until then it counts for no one.",
	);
}

export const actions: Actions = {
	/** @spec SM-4.3.1-contest */
	contest: async (event) => {
		const user = requireUser(event);
		const data = await event.request.formData();
		const rescindId = field(data, "rescindId");
		const result = await contestAsBuyer(db(), env.ENGINE, {
			rescindId,
			buyerId: user.id,
			text: field(data, "text"),
		});
		return done(result, rescindId, "Contest sent. An admin will decide; until then it counts for no one.");
	},
	/** @spec SM-4.3.1-mutual */
	agree: (event) => answer(event, true),
	/** @spec SM-4.3.1-mutual */
	dispute: (event) => answer(event, false),
};
