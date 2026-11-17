import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { cookieSecret, db } from "#lib/server/context.ts";
import { placeEntry } from "#lib/server/entries.ts";
import { unlockCookieName } from "#lib/server/sale-access.ts";
import type { RequestHandler } from "./$types";

/**
 * A claim or an offer: `{ "itemId": "…", "kind": "claim" }` or
 * `{ "itemId": "…", "kind": "offer", "amountCents": 3500 }`. Runs in the sale's
 * SaleEngine (STATE_MACHINES §4.1); a rule's "no" comes back as `{ code, message }`.
 */
export const POST: RequestHandler = async ({ request, params, locals, cookies }) => {
	const body: unknown = await request.json().catch(() => null);
	const response = await placeEntry(
		{ db: db(), secret: cookieSecret(), engine: env.ENGINE },
		{ user: locals.user, unlockCookie: cookies.get(unlockCookieName(params.saleId)) },
		params.saleId,
		body,
	);
	return json(response.body, { status: response.status });
};
