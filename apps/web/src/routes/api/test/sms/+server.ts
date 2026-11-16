import { normalizePhone } from "@claimsale/core";
import { verifications } from "@claimsale/db/schema";
import { error, json } from "@sveltejs/kit";
import { desc, eq } from "@claimsale/db";
import { db, smsCaptureEnabled } from "#lib/server/context.ts";
import { CAPTURE_PREFIX } from "#lib/server/sms.ts";
import type { RequestHandler } from "./$types";

/**
 * Test-only (TECH_STACK S41): the latest captured phone code for one number, so E2E
 * tests can verify a phone. 404 wherever codes are really sent (staging, its
 * Previews, production).
 */
export const GET: RequestHandler = async ({ url }) => {
	if (!smsCaptureEnabled()) error(404, "Not found");
	const phone = normalizePhone(url.searchParams.get("to") ?? "");
	if (!phone.ok) error(400, "Pass ?to=<phone number>");
	const row = await db()
		.select({ code: verifications.value, createdAt: verifications.createdAt })
		.from(verifications)
		.where(eq(verifications.identifier, `${CAPTURE_PREFIX}${phone.value}`))
		.orderBy(desc(verifications.createdAt))
		.get();
	return json(row ? { code: row.code } : null, { headers: { "cache-control": "no-store" } });
};
