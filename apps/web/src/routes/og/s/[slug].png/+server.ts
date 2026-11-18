import { error } from "@sveltejs/kit";
import { Effect } from "effect";
import { db, shareImageStore } from "#lib/server/context.ts";
import { plainShareCard, renderShareCard } from "#lib/server/og-render.ts";
import { runExit } from "#lib/server/runtime.ts";
import { cachedShareImage, loadShareCard } from "#lib/server/share-card.ts";
import type { RequestHandler } from "./$types";

/**
 * The share image for a sale link (`og:image`, WS-L2). Public: it's what a signed-out
 * visitor may see (SHARE-private-title-only), cached in R2 per card version.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const loaded = await loadShareCard(db(), params.slug);
	if (!loaded) error(404, "No such sale");
	const { saleId, card, version } = loaded;
	// A versioned URL never changes; the bare one follows the sale.
	const maxAge = url.searchParams.get("v") === version ? 86_400 : 300;
	const headers = { "content-type": "image/png", "cache-control": `public, max-age=${maxAge}` };
	try {
		const { body } = await cachedShareImage(shareImageStore(), saleId, version, () => renderShareCard(card));
		return new Response(body, { headers });
	} catch (cause) {
		// Most likely an emoji the renderer couldn't fetch: serve the card without them,
		// uncached, so the next request tries again.
		await runExit(
			"web.og.render_fallback",
			Effect.logWarning("share card render failed; serving it without emoji").pipe(
				Effect.annotateLogs({ error: cause instanceof Error ? cause.message : String(cause) }),
			),
		);
		const png = await renderShareCard(plainShareCard(card));
		return new Response(png, { headers: { ...headers, "cache-control": "public, max-age=60" } });
	}
};
