import { redirect } from "@sveltejs/kit";
import type { Handle, HandleServerError } from "@sveltejs/kit/hooks";
import { auth } from "#lib/server/context.ts";
import { isOnboardingExempt, needsOnboarding } from "#lib/server/onboarding.ts";
import { activeTraceIds, reportError } from "#lib/server/runtime.ts";

/** Paths that never need the session: Better Auth's own routes and machine endpoints. */
const SESSIONLESS = ["/api/auth/", "/api/health", "/api/debug/", "/api/test/", "/_app/"];

/**
 * Loads the session into `locals` and sends accounts that haven't finished
 * onboarding there.
 */
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.session = null;
	const path = event.url.pathname;
	if (!SESSIONLESS.some((prefix) => path.startsWith(prefix))) {
		const current = await auth(event.url.origin).api.getSession({ headers: event.request.headers });
		if (current) {
			event.locals.user = current.user;
			event.locals.session = { id: current.session.id, expiresAt: current.session.expiresAt };
		}
		if (needsOnboarding(event.locals.user) && !isOnboardingExempt(path)) {
			redirect(303, `/onboarding?next=${encodeURIComponent(path + event.url.search)}`);
		}
	}
	return resolve(event);
};

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
