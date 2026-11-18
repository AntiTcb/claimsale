import { error } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { whoHas } from "#lib/server/discovery.ts";
import type { PageServerLoad } from "./$types";

/**
 * "Who has this card?" (PLAN §3): every listing of one catalog product across public
 * scheduled and live sales.
 *
 * @spec DISC-who-has
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	const id = Number(params.productId);
	if (!Number.isSafeInteger(id) || id < 1) error(404, "No such card");
	const result = await whoHas(db(), id);
	if (!result) error(404, "No such card");
	return { ...result, signedIn: locals.user !== null };
};
