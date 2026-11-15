import { emailOutbox } from "@claimsale/db/schema";
import { error, json } from "@sveltejs/kit";
import { desc, eq } from "@claimsale/db";
import { db, outboxEnabled } from "#lib/server/context.ts";
import type { RequestHandler } from "./$types";

/**
 * Test-only (TECH_STACK §10): the latest captured emails for one address, so E2E
 * tests can follow verification, magic-link and reset links. 404 wherever mail is
 * really sent (staging, its Previews, production).
 */
export const GET: RequestHandler = async ({ url }) => {
	if (!outboxEnabled()) error(404, "Not found");
	const to = url.searchParams.get("to")?.trim().toLowerCase();
	if (!to) error(400, "Pass ?to=<address>");
	const messages = await db()
		.select({ subject: emailOutbox.subject, text: emailOutbox.text, createdAt: emailOutbox.createdAt })
		.from(emailOutbox)
		.where(eq(emailOutbox.to, to))
		.orderBy(desc(emailOutbox.createdAt), desc(emailOutbox.id))
		.limit(10);
	return json(messages, { headers: { "cache-control": "no-store" } });
};
