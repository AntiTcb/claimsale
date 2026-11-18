import { CONDITIONS, type Condition } from "./games.ts";
import { formatCents, type Cents } from "./money.ts";

/**
 * Discovery (milestone 10, WS-L): browse by game, search, "who has this card?" and the
 * seller's "copy as text" export. Pure rules here; the D1 queries are in the web Worker.
 */

/** Sales that browse, search and "who has this card?" show: upcoming and live ones. */
export const DISCOVERABLE_STATUSES = ["scheduled", "live"] as const;

/**
 * Whether a sale appears in browse, game pages, search and "who has this card?".
 *
 * @spec DISC-public-only — public sales that are scheduled or live only; drafts, unlisted,
 * private, closed and deleted sales never appear (D28, D56).
 */
export function isDiscoverable(sale: { readonly status: string; readonly visibility: string }): boolean {
	return sale.visibility === "public" && (DISCOVERABLE_STATUSES as readonly string[]).includes(sale.status);
}

export const ITEM_SORTS = ["ending", "starting", "price_asc", "price_desc", "newest"] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];

export const ITEM_SORT_LABELS: Readonly<Record<ItemSort, string>> = {
	ending: "Ending soon",
	starting: "Going live soon",
	price_asc: "Price: low to high",
	price_desc: "Price: high to low",
	newest: "Newest",
};

export const BROWSE_KINDS = ["single", "graded", "sealed", "accessory", "lot"] as const;
export type BrowseKind = (typeof BROWSE_KINDS)[number];

/** Browse filters, validated. Text filters match the catalog's own spelling exactly. */
export interface ItemFilters {
	readonly kind: BrowseKind | null;
	/** Conditions to include; empty means any. */
	readonly conditions: readonly Condition[];
	readonly set: string | null;
	readonly rarity: string | null;
	readonly language: string | null;
	readonly finish: string | null;
	readonly minCents: Cents | null;
	readonly maxCents: Cents | null;
	readonly sort: ItemSort;
	/** 1-based. */
	readonly page: number;
}

const isKind = (value: string | null): value is BrowseKind =>
	(BROWSE_KINDS as readonly (string | null)[]).includes(value);
const isSort = (value: string | null): value is ItemSort =>
	(ITEM_SORTS as readonly (string | null)[]).includes(value);

export const ITEMS_PER_PAGE = 48;
const MAX_PAGE = 50;
const MAX_TEXT = 120;
/** $100,000, the most an item can cost. */
const MAX_PRICE_CENTS = 10_000_000;

interface Params {
	get(name: string): string | null;
	getAll(name: string): string[];
}

const text = (value: string | null): string | null => {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed.slice(0, MAX_TEXT);
};

/** Whole dollars or dollars and cents, as typed into a filter; anything else is ignored. */
export function parseDollars(value: string | null): Cents | null {
	const trimmed = value?.trim().replace(/^\$/, "").replaceAll(",", "") ?? "";
	if (!/^\d{1,6}(\.\d{1,2})?$/.test(trimmed)) return null;
	const [whole, fraction = ""] = trimmed.split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	return cents <= MAX_PRICE_CENTS ? cents : null;
}

/**
 * The filters from a browse URL. Unknown or malformed values are dropped rather than
 * rejected: a shared link with a stale filter still shows something.
 */
export function parseItemFilters(params: Params): ItemFilters {
	const kind = params.get("kind");
	const sort = params.get("sort");
	const page = Number(params.get("page") ?? "1");
	let minCents = parseDollars(params.get("min"));
	let maxCents = parseDollars(params.get("max"));
	if (minCents !== null && maxCents !== null && minCents > maxCents)
		[minCents, maxCents] = [maxCents, minCents];
	return {
		kind: isKind(kind) ? kind : null,
		conditions: [...new Set(params.getAll("condition"))].filter((c): c is Condition =>
			(CONDITIONS as readonly string[]).includes(c),
		),
		set: text(params.get("set")),
		rarity: text(params.get("rarity")),
		language: text(params.get("language")),
		finish: text(params.get("finish")),
		minCents,
		maxCents,
		sort: isSort(sort) ? sort : "ending",
		page: Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1,
	};
}

/** The URL query for filters, leaving defaults out so links stay short. */
export function itemFiltersQuery(filters: ItemFilters, overrides: Partial<ItemFilters> = {}): string {
	const f = { ...filters, ...overrides };
	const pairs: Array<[string, string]> = [];
	if (f.kind) pairs.push(["kind", f.kind]);
	for (const c of f.conditions) pairs.push(["condition", c]);
	if (f.set) pairs.push(["set", f.set]);
	if (f.rarity) pairs.push(["rarity", f.rarity]);
	if (f.language) pairs.push(["language", f.language]);
	if (f.finish) pairs.push(["finish", f.finish]);
	if (f.minCents !== null) pairs.push(["min", (f.minCents / 100).toFixed(2)]);
	if (f.maxCents !== null) pairs.push(["max", (f.maxCents / 100).toFixed(2)]);
	if (f.sort !== "ending") pairs.push(["sort", f.sort]);
	if (f.page > 1) pairs.push(["page", String(f.page)]);
	// encodeURIComponent, like URLSearchParams but with %20 for spaces; both read back the same.
	const query = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
	return query === "" ? "" : `?${query}`;
}

/** Search words: letters and digits only, at most 8, each at least 2 characters. */
export function searchTerms(query: string): string[] {
	return [
		...new Set(
			query
				.normalize("NFKD")
				.replace(/\p{M}+/gu, "")
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)
				.filter((w) => w.length >= 2),
		),
	].slice(0, 8);
}

// ---------------------------------------------------------------------------
// "Copy as text" (PLAN §6 Phase 1: the item list for a Facebook post body)

export interface TextExportItem {
	readonly title: string;
	readonly priceCents: Cents;
	readonly quantity: number;
	readonly condition: string | null;
	readonly state: string;
}

/**
 * The sale's item list as plain text for a Facebook post: the title, when it goes live,
 * one numbered line per item and the link to claim.
 *
 * @spec DISC-copy-text — items in sale order with price, condition and quantity; withdrawn
 * items are left out and sold-out ones marked; only buyer-facing fields go in (no hidden
 * minimum, SKU or market price).
 */
export function saleAsText(
	sale: { readonly title: string; readonly url: string; readonly when: string | null },
	items: readonly TextExportItem[],
): string {
	const lines = [sale.title];
	if (sale.when) lines.push(sale.when);
	lines.push("");
	let n = 0;
	for (const item of items) {
		if (item.state === "withdrawn") continue;
		n += 1;
		const parts = [`${n}. ${item.title}`];
		if (item.condition) parts.push(item.condition);
		parts.push(formatCents(item.priceCents));
		let line = parts.join(" · ");
		if (item.quantity > 1) line += ` (${item.quantity} available)`;
		if (item.state === "sold_out") line += " SOLD";
		lines.push(line);
	}
	if (n === 0) lines.push("No items yet.");
	lines.push("", `Claim here: ${sale.url}`);
	return lines.join("\n");
}
