import { db } from "#lib/server/context.ts";
import { inbox } from "#lib/server/messaging.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { PageServerLoad } from "./$types";

/** The user's conversations, as a buyer and as a seller (D18). */
export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	return { conversations: await inbox(db(), user.id) };
};
