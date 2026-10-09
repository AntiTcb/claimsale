import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { webHealth } from "#lib/server/health.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
	const report = await webHealth(env);
	return json(report, {
		status: report.status === "ok" ? 200 : 503,
		headers: { "cache-control": "no-store" },
	});
};
