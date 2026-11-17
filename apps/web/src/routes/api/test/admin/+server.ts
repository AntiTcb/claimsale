import { users } from "@claimsale/db/schema";
import { error, json } from "@sveltejs/kit";
import { eq } from "@claimsale/db";
import { db, outboxEnabled } from "#lib/server/context.ts";
import type { RequestHandler } from "./$types";

/**
 * Test-only: makes the account with this email an admin, so E2E tests can open /admin.
 * Only where test endpoints are on (captured mail, never shared data); 404 on staging,
 * its Previews and production, where the role is set with SQL (#lib/server/admin.ts).
 */
export const POST: RequestHandler = async ({ url }) => {
	if (!outboxEnabled()) error(404, "Not found");
	const email = (url.searchParams.get("email") ?? "").toLowerCase();
	if (!email.endsWith("@example.test")) error(400, "Pass ?email=<an @example.test address>");
	const rows = await db()
		.update(users)
		.set({ role: "admin" })
		.where(eq(users.email, email))
		.returning()
		.all();
	return json({ updated: rows.length }, { headers: { "cache-control": "no-store" } });
};
