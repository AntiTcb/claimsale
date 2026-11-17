import { applyCatalogAutofill, type CatalogProduct } from "@claimsale/core";
import type { CatalogHit } from "#lib/market.ts";
import { readAttributes } from "#lib/market.ts";

/**
 * Picking a product in the item form's or table editor's type-ahead (PLAN §3
 * "Autofill UX"). The form keeps its fields as text, so this works on those.
 */

export interface ItemFormFields {
	readonly title: string;
	readonly gameId: string;
	readonly kind: string;
	/** The attributes JSON text field. */
	readonly attributes: string;
}

export const toCatalogProduct = (hit: CatalogHit): CatalogProduct => ({
	tcgplayerProductId: hit.tcgplayerProductId,
	game: hit.game,
	kind: hit.kind,
	name: hit.name,
	setCode: hit.setCode,
	setName: hit.setName,
	number: hit.number,
	rarity: hit.rarity,
	productType: hit.productType,
});

/** Accessories and lots aren't in the catalog, so they get no type-ahead. */
export const isCatalogKind = (kind: string): kind is "single" | "graded" | "sealed" =>
	kind === "single" || kind === "graded" || kind === "sealed";

/** The catalog product kind a form kind searches for. */
export const productKindFor = (kind: string): "single" | "sealed" | null =>
	kind === "sealed" ? "sealed" : kind === "single" || kind === "graded" ? "single" : null;

/**
 * Applies a picked product to the form.
 *
 * @spec TCG-autofill-only — only the game and the catalog attributes change (core's
 * `replace` merge, so a stale number from an earlier pick doesn't linger). Price,
 * quantity, condition, finish and the seller's other attributes stay as they are; the
 * title is filled only while it is still blank.
 */
export function autofillForm<T extends ItemFormFields>(
	form: T,
	hit: CatalogHit,
): { ok: true; value: T } | { ok: false; message: string } {
	if (!isCatalogKind(form.kind)) return { ok: false, message: "Accessories and lots aren't in the catalog" };
	const merged = applyCatalogAutofill(
		{ game: form.gameId, kind: form.kind, attributes: readAttributes(form.attributes) },
		toCatalogProduct(hit),
		"replace",
	);
	if (!merged.ok) return { ok: false, message: merged.error.message };
	return {
		ok: true,
		value: {
			...form,
			title: form.title.trim() === "" ? hit.name : form.title,
			gameId: merged.value.game ?? form.gameId,
			attributes: JSON.stringify(merged.value.attributes),
		},
	};
}
