import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { cookieSecret, db } from "#lib/server/context.ts";
import { entryAction } from "#lib/server/entries.ts";
import { unlockCookieName } from "#lib/server/sale-access.ts";
import type { RequestHandler } from "./$types";

/**
 * The buyer acts on their own entry: `{ "itemId": "…", "action": "withdraw_offer" }`, or
 * `leave_queue`, `accept_counter`, `decline_counter` (STATE_MACHINES §4.4). Runs in the
 * sale's SaleEngine; a rule's "no" comes back as `{ code, message }`.
 */
export const POST: RequestHandler = async ({ request, params, locals, cookies }) => {
	const body: unknown = await request.json().catch(() => null);
	const response = await entryAction(
		{ db: db(), secret: cookieSecret(), engine: env.ENGINE },
		{ user: locals.user, unlockCookie: cookies.get(unlockCookieName(params.saleId)) },
		params.saleId,
		params.entryId,
		body,
	);
	return json(response.body, { status: response.status });
};
