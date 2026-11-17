import { ITEM_KINDS } from "@claimsale/core";
import { json } from "@sveltejs/kit";
import { Result as EffectResult, Schema } from "effect";
import { marketPricesFor, matchRows } from "#lib/server/catalog.ts";
import { db } from "#lib/server/context.ts";
import { IMPORT_BATCH_SIZE } from "#lib/server/import.ts";
import { jsonBody, sellerSaleForApi } from "#lib/server/seller-api.ts";
import type { RequestHandler } from "./$types";

const MatchBody = Schema.Struct({
	rows: Schema.Array(
		Schema.Struct({
			row: Schema.Int,
			game: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
			kind: Schema.Literals(ITEM_KINDS),
			attributes: Schema.Record(
				Schema.String.check(Schema.isMaxLength(64)),
				Schema.Union([Schema.String.check(Schema.isMaxLength(10_000)), Schema.Number, Schema.Boolean]),
			),
		}),
	).check(Schema.isMaxLength(IMPORT_BATCH_SIZE)),
});
const decode = Schema.decodeUnknownResult(MatchBody);

/**
 * The import preview's catalog matching (TCG-catalog-match), up to 100 rows a call,
 * with the market prices of every matched or candidate product for the "% of market"
 * fill. Seller-only: the gate checks the seller owns this sale (TCG-market-placeholder).
 */
export const POST: RequestHandler = async (event) => {
	const gate = await sellerSaleForApi(event);
	if (!gate.ok) return gate.response;
	const body = decode(await jsonBody(event.request));
	if (EffectResult.isFailure(body)) return json({ message: "Those rows aren't valid" }, { status: 400 });
	const matches = await matchRows(db(), body.success.rows);
	const productIds = matches.flatMap((m) =>
		m.status === "matched"
			? [m.product.productId]
			: m.status === "ambiguous"
				? m.candidates.map((c) => c.productId)
				: [],
	);
	const prices = await marketPricesFor(db(), productIds);
	return json({ matches, prices: Object.fromEntries(prices) });
};
