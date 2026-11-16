import { isListed, type SaleAccess } from "@claimsale/core";
import { error, type RequestEvent } from "@sveltejs/kit";
import { readTerms, type SaleTerms } from "#lib/listing-input.ts";
import { cookieSecret, db } from "./context.ts";
import type { ItemRow } from "./items.ts";
import { accessFor, unlockCookieName } from "./sale-access.ts";
import { findSaleBySlug, type PublicSale } from "./sales.ts";

/**
 * Loads a sale for /s/[slug] and decides what this viewer may see (SM-2-visibility).
 * A draft or deleted sale is a 404 for everyone but its seller, exactly like a
 * missing one, so slugs can't be probed.
 */
export async function loadSaleForViewer(
	event: Pick<RequestEvent, "locals" | "cookies">,
	slug: string,
): Promise<{ sale: PublicSale; access: Exclude<SaleAccess, "not_found">; isSeller: boolean }> {
	const sale = await findSaleBySlug(db(), slug);
	if (!sale) error(404, "No such sale");
	const access = await accessFor(db(), cookieSecret(), sale, {
		user: event.locals.user,
		unlockCookie: event.cookies.get(unlockCookieName(sale.id)),
	});
	if (access === "not_found") error(404, "No such sale");
	return { sale, access, isSeller: event.locals.user?.id === sale.sellerId };
}

/** What every visitor may see of a sale header, even a locked private one (PLAN §3: title and seller only). */
export function saleHeader(sale: PublicSale) {
	return {
		slug: sale.slug,
		title: sale.title,
		sellerHandle: sale.sellerHandle,
		sellerDisplayName: sale.sellerDisplayName,
		status: sale.status,
		visibility: sale.visibility,
		/** Search engines index only public sales (D5, D56). */
		indexable: isListed(sale),
	};
}

export interface PublicSaleBody {
	readonly descriptionMd: string;
	readonly liveAt: number | null;
	readonly closesAt: number | null;
	readonly terms: SaleTerms;
}

export function saleBody(sale: PublicSale): PublicSaleBody {
	return {
		descriptionMd: sale.descriptionMd,
		liveAt: sale.liveAt,
		closesAt: sale.closesAt,
		terms: readTerms(sale.terms),
	};
}

/**
 * The buyer-facing fields of an item. Never the hidden minimum offer (D27) or the
 * seller's SKU; market prices never reach buyers either (TCG-market-placeholder, WS-C).
 */
export function publicItem(item: ItemRow) {
	return {
		id: item.id,
		title: item.title,
		descriptionMd: item.descriptionMd,
		priceCents: item.priceCents,
		quantity: item.quantity,
		gameId: item.gameId,
		kind: item.kind,
		condition: item.condition,
		attributes: item.attributes,
		state: item.state,
		unitsWon: item.unitsWon,
	};
}
