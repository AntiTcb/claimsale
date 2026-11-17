import { json } from "@sveltejs/kit";
import { productKindFor } from "#lib/catalog-autofill.ts";
import type { CatalogHit } from "#lib/market.ts";
import { engineRpc } from "#lib/server/context.ts";
import { sellerSaleForApi } from "#lib/server/seller-api.ts";
import type { RequestHandler } from "./$types";

/**
 * The item form's catalog type-ahead (PLAN §3 "Autofill UX", D60), through the
 * engine's `searchCatalog` RPC (FTS5 ranking lives there). Hits carry the autofill
 * fields only, never a price. `kind` narrows singles / graded to single cards and
 * sealed to sealed products.
 */
export const GET: RequestHandler = async (event) => {
	const gate = await sellerSaleForApi(event);
	if (!gate.ok) return gate.response;
	const query = (event.url.searchParams.get("q") ?? "").slice(0, 100);
	const game = event.url.searchParams.get("game") || undefined;
	const productKind = productKindFor(event.url.searchParams.get("kind") ?? "single");
	if (query.trim().length < 2 || productKind === null) return json({ hits: [] });
	try {
		const result = await engineRpc().searchCatalog({ query, ...(game ? { game } : {}), limit: 25 });
		if (!result.ok) return json({ hits: [], message: "Search is unavailable" }, { status: 503 });
		const hits: CatalogHit[] = result.value.filter((hit) => hit.kind === productKind).slice(0, 10);
		return json({ hits }, { headers: { "cache-control": "private, max-age=60" } });
	} catch {
		// `pnpm dev:ui` runs without the engine; the form still works without autofill.
		return json({ hits: [], message: "Search is unavailable" }, { status: 503 });
	}
};
