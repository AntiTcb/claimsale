import type { HandleServerError } from "@sveltejs/kit/hooks";
import { activeTraceIds, reportError } from "#lib/server/runtime.ts";

/**
 * Unexpected errors go to Sentry, tagged with the trace ID (TECH_STACK §4). App
 * errors (`error(404)`, …) and framework errors are expected and not reported.
 * The trace ID is returned so an error page can show it for support.
 */
export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind !== "unknown") return undefined;
	reportError(error, { route: event.route.id ?? "unknown", method: event.request.method });
	const { traceId } = activeTraceIds();
	return traceId ? { message: "Internal Error", traceId } : undefined;
};
