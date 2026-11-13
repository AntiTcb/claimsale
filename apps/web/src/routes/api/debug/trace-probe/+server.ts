import { error, json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { Cause, Exit } from "effect";
import { activeTraceIds, runExit } from "#lib/server/runtime.ts";
import { isProbeEnabled, probe } from "#lib/server/trace-probe.ts";
import type { RequestHandler } from "./$types";

/** The T28 observability spike: POST {"fail"?: boolean}. Not available in production. */
export const POST: RequestHandler = async ({ request }) => {
	if (!isProbeEnabled(env.APP_ENV)) error(404, "Not found");
	const body: unknown = await request.json().catch(() => ({}));
	const exit = await runExit("web.trace_probe", probe(env.ENGINE, body));
	const headers = { "cache-control": "no-store" };
	if (Exit.isSuccess(exit)) {
		return json(exit.value, { headers: { ...headers, "x-trace-id": exit.value.web.traceId } });
	}
	const failure = Cause.findErrorOption(exit.cause);
	const { traceId } = activeTraceIds();
	if (failure._tag === "Some") {
		const status = failure.value.stage === "request" ? 400 : 502;
		return json({ error: failure.value.message, stage: failure.value.stage, traceId }, { status, headers });
	}
	// A defect in the web Worker: already reported to Sentry by runExit.
	return json({ error: "Internal error", traceId }, { status: 500, headers });
};
