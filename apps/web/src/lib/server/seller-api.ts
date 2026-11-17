import { json, type RequestEvent } from "@sveltejs/kit";
import { db } from "./context.ts";
import { entitlements } from "./entitlements.ts";
import { findSellerSale, type SaleRow, type Seller } from "./sales.ts";
import { sellerReadiness } from "./seller.ts";

/**
 * The /sell JSON endpoints' gate: the same checks as `requireSeller` + `requireOwnSale`
 * (D55 seller requirements, the seller's own sale), answered with a status code
 * instead of a redirect, since a fetch can't follow one to a page.
 */
export async function sellerSaleForApi(
	event: Pick<RequestEvent, "locals" | "params">,
): Promise<{ ok: true; seller: Seller; sale: SaleRow } | { ok: false; response: Response }> {
	const user = event.locals.user;
	if (!user) return { ok: false, response: json({ message: "Sign in first" }, { status: 401 }) };
	const tier = (await entitlements(db(), user.id, Date.now())).seller;
	if (sellerReadiness(user, tier).length > 0) {
		return {
			ok: false,
			response: json({ message: "Finish the seller requirements first" }, { status: 403 }),
		};
	}
	const saleId = (event.params as Record<string, string | undefined>)["saleId"] ?? "";
	const sale = await findSellerSale(db(), user.id, saleId);
	if (!sale) return { ok: false, response: json({ message: "No such sale" }, { status: 404 }) };
	return { ok: true, seller: { id: user.id, tier }, sale };
}

/** Reads a JSON body, or null when it isn't JSON. */
export async function jsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return null;
	}
}
