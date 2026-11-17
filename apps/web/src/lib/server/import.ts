import { isNoGame, type ExistingItem } from "@claimsale/core";
import type { ItemRow } from "./items.ts";

/**
 * Item import on the web side (PLAN §3c.1). Applying a batch happens in the engine:
 * the apply route calls the `applyImportBatch` RPC, which runs under the sale's
 * Durable Object lock (apps/engine/src/sale/import.ts). The web only reads.
 */

/** A stored item as the import planner compares it (the preview's create / update counts). */
export function toExisting(row: ItemRow): ExistingItem {
	const attributes: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(row.attributes)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
			attributes[key] = value;
	}
	return {
		id: row.id,
		sku: row.sku,
		game: isNoGame(row.gameId) ? null : row.gameId,
		kind: row.kind,
		title: row.title,
		description: row.descriptionMd,
		priceCents: row.priceCents,
		quantity: row.quantity,
		offers: row.offersMode === "on_min" ? "min" : row.offersMode,
		minOfferCents: row.minOfferCents,
		shippingOverrideCents: row.shippingOverrideCents,
		attributes,
	};
}
