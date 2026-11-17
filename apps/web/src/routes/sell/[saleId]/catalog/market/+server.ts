import { json } from "@sveltejs/kit";
import { defaultMarketPercent, marketPricesFor } from "#lib/server/catalog.ts";
import { db } from "#lib/server/context.ts";
import { sellerSaleForApi } from "#lib/server/seller-api.ts";
import type { RequestHandler } from "./$types";

/**
 * Market prices for one catalog product, for the price field's placeholder and
 * % buttons (D64). Only the seller of this sale gets them (TCG-market-placeholder);
 * no buyer-facing page or endpoint reads market prices.
 */
export const GET: RequestHandler = async (event) => {
	const gate = await sellerSaleForApi(event);
	if (!gate.ok) return gate.response;
	const productId = Number(event.url.searchParams.get("product"));
	if (!Number.isSafeInteger(productId) || productId <= 0) {
		return json({ message: "Which product?" }, { status: 400 });
	}
	const prices = (await marketPricesFor(db(), [productId])).get(productId) ?? [];
	return json(
		{ prices, defaultPercent: await defaultMarketPercent(db(), gate.seller.id) },
		{ headers: { "cache-control": "private, no-store" } },
	);
};
