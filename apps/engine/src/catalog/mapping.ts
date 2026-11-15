/**
 * Pure mapping from TCGCSV's JSON (TCGplayer's catalog) onto ClaimSale's catalog rows
 * (PLAN §6, D60). Only the autofill fields are kept: name, set, number, rarity,
 * product type and the TCGplayer IDs. Card text, images and URLs are dropped on
 * purpose (D60: no third-party images).
 *
 * Game-specific knowledge stays in this file so it can be reconciled with
 * packages/core's games registry later.
 */
import type { TcgCsvGroup, TcgCsvPrice, TcgCsvProduct } from "./tcgcsv.ts";

export interface SetRow {
	readonly tcgplayerGroupId: number;
	readonly code: string | null;
	readonly name: string;
	/** `YYYY-MM-DD` */
	readonly releaseDate: string | null;
}

export interface ProductRow {
	readonly tcgplayerProductId: number;
	readonly kind: "single" | "sealed";
	readonly name: string;
	readonly number: string | null;
	readonly rarity: string | null;
	readonly productType: string | null;
}

export interface PriceRow {
	readonly tcgplayerProductId: number;
	readonly subtype: string;
	readonly marketCents: number | null;
}

/** Whole cents from TCGplayer's dollar doubles; null for a missing or invalid price. */
export function dollarsToCents(dollars: number | null | undefined): number | null {
	if (dollars === null || dollars === undefined || !Number.isFinite(dollars) || dollars < 0) return null;
	// Rounded twice: 1.005 * 100 is 100.49999999999999 in binary floating point.
	return Math.round(Number.parseFloat((dollars * 100).toFixed(6)));
}

/**
 * Milliseconds for a TCGCSV timestamp. `last-updated.txt` has an offset without a
 * colon (`2026-11-15T20:06:00+0000`); TCGplayer's own fields have none at all and are
 * read as UTC. Returns null when unparseable.
 */
export function parseTcgCsvTime(value: string | null | undefined): number | null {
	if (!value) return null;
	let text = value.trim();
	if (/[+-]\d{4}$/.test(text)) text = `${text.slice(0, -2)}:${text.slice(-2)}`;
	else if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text = `${text}Z`;
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? null : ms;
}

const clean = (value: string | null | undefined): string | null => {
	const text = value?.replace(/\s+/g, " ").trim();
	return text ? text : null;
};

function extended(product: TcgCsvProduct, name: string): string | null {
	const entry = product.extendedData?.find((e) => e.name.toLowerCase() === name.toLowerCase());
	return clean(entry?.value);
}

/** Sealed product types, checked in order (the first match wins). */
const SEALED_TYPES: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bcase\b/i, "Case"],
	[/\belite trainer box\b/i, "Elite Trainer Box"],
	[/\bbooster box\b/i, "Booster Box"],
	[/\bbooster (pack|packet)\b/i, "Booster Pack"],
	[/\bcollector booster\b/i, "Booster Pack"],
	[/\bbundle\b/i, "Bundle"],
	[/\b(starter|structure|theme|precon(structed)?|commander|challenger) deck\b|\bdeck\b/i, "Deck"],
	[/\btin\b/i, "Tin"],
	[/\bbox set\b|\bgift (box|set)\b/i, "Box Set"],
	[/\bcollection\b/i, "Collection"],
	[/\bblister\b/i, "Blister"],
	[/\bdisplay\b/i, "Booster Box"],
];

/** A best-effort product type for sealed product, from its name; null if unknown. */
export function sealedProductType(name: string): string | null {
	for (const [pattern, type] of SEALED_TYPES) if (pattern.test(name)) return type;
	return null;
}

/** TCGplayer marks cards with a collector number or rarity; everything else is sealed. */
export function productKind(product: TcgCsvProduct): "single" | "sealed" {
	return extended(product, "Number") !== null || extended(product, "Rarity") !== null ? "single" : "sealed";
}

export function toSetRow(group: TcgCsvGroup): SetRow {
	return {
		tcgplayerGroupId: group.groupId,
		code: clean(group.abbreviation),
		name: clean(group.name) ?? `Group ${group.groupId}`,
		releaseDate: /^\d{4}-\d{2}-\d{2}/.test(group.publishedOn ?? "") ? group.publishedOn!.slice(0, 10) : null,
	};
}

export function toProductRow(product: TcgCsvProduct): ProductRow {
	const kind = productKind(product);
	const name = clean(product.name) ?? `Product ${product.productId}`;
	return {
		tcgplayerProductId: product.productId,
		kind,
		name,
		number: extended(product, "Number"),
		rarity: extended(product, "Rarity"),
		productType: kind === "sealed" ? sealedProductType(name) : null,
	};
}

export function toPriceRow(price: TcgCsvPrice): PriceRow | null {
	const subtype = clean(price.subTypeName);
	if (subtype === null) return null;
	return { tcgplayerProductId: price.productId, subtype, marketCents: dollarsToCents(price.marketPrice) };
}
