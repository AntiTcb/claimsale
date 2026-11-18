import { env } from "cloudflare:workers";
import { cookieSecret, db } from "#lib/server/context.ts";
import { liveUpgrade } from "#lib/server/live.ts";
import { unlockCookieName } from "#lib/server/sale-access.ts";
import type { RequestHandler } from "./$types";

/**
 * The live sale socket (PLAN §7): a WebSocket upgrade, checked here and forwarded to the
 * sale's SaleEngine, which sends server time, a snapshot and then one diff per commit.
 * Message shapes: `LiveMessage` in packages/core/src/live.ts.
 */
export const GET: RequestHandler = async ({ request, params, locals, cookies, url }) => {
	const decision = await liveUpgrade(
		{ db: db(), secret: cookieSecret() },
		{ user: locals.user, unlockCookie: cookies.get(unlockCookieName(params.saleId)) },
		params.saleId,
		request,
		url.origin,
	);
	if (decision.kind === "refuse") return new Response(decision.message, { status: decision.status });
	const upstream = await env.ENGINE.fetch(decision.request);
	if (upstream.status !== 101 || !upstream.webSocket) {
		return new Response("The live connection isn't available", {
			status: upstream.status === 404 ? 404 : 503,
		});
	}
	// A new Response, so SvelteKit can still add headers (the engine's are immutable).
	return new Response(null, { status: 101, webSocket: upstream.webSocket });
};
