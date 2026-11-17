import { json } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { fileReport } from "#lib/server/moderation.ts";
import type { RequestHandler } from "./$types";

/**
 * Report a user, sale, item or message to the admin queue (ADMIN-report-queue):
 * `{ "targetKind": "sale", "targetId": "…", "reason": "counterfeit", "details": "…" }`.
 * Signed-in users only; report buttons (sale pages, messages) post here.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ code: "unauthenticated", message: "Sign in to report" }, { status: 401 });
	const body: unknown = await request.json().catch(() => null);
	const result = await fileReport(db(), locals.user.id, body, Date.now());
	if (result.ok) return json(result.value, { status: 201 });
	const status = { not_found: 404, already_reported: 409, rate_limited: 429 }[result.error.code] ?? 400;
	return json(result.error, { status });
};
