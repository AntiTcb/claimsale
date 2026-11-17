import {
	attributeFields,
	coerceAttributes,
	gameRequired,
	ITEM_KIND_LABELS,
	ITEM_KINDS,
	validateAttributes,
	type Attributes,
	type FieldIssue,
	type ItemKind,
} from "../attributes.ts";
import { err, ok, reject, type Rejection, type Result, type Tier } from "../common.ts";
import { resolveGame } from "../games.ts";
import type { Cents } from "../money.ts";
import { FREE_ITEM_CAP } from "../plans.ts";
import type { SaleStatus } from "../sale.ts";
import { listingPolicyViolations } from "../tcg.ts";
import { parseCents, unescapeFormula } from "./cells.ts";

/**
 * Item import (PLAN §3c.1, §3c.4): validate mapped rows with the shared schemas, then
 * plan creates / updates / removals against the sale's current items. Nothing here
 * writes; the engine applies a confirmed plan in batches.
 */

export const MAX_IMPORT_ROWS = 2000;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_SKU_LENGTH = 64;
export const MAX_QUANTITY = 999;

export type OffersMode = "off" | "on" | "min";
export const OFFERS_MODES: readonly OffersMode[] = ["off", "on", "min"];

/** The fields an import can set on an item. */
export interface ImportFields {
	readonly sku: string | null;
	readonly game: string | null;
	readonly kind: ItemKind;
	readonly title: string;
	readonly description: string;
	readonly priceCents: Cents;
	readonly quantity: number;
	readonly offers: OffersMode;
	readonly minOfferCents: Cents | null;
	readonly shippingOverrideCents: Cents | null;
	readonly attributes: Attributes;
}

/** A validated row. */
export interface ImportedItem extends ImportFields {
	/** The exported `item_id`, when the row came from an items export. */
	readonly itemId: string | null;
	/** Photo file names in the ZIP; on an update they are added, never replace. */
	readonly photos: readonly string[];
}

/** One mapped data row; `row` is its line in the spreadsheet (the header is row 1). */
export interface MappedRow {
	readonly row: number;
	readonly cells: Readonly<Record<string, string>>;
}

const KIND_ALIASES: Readonly<Record<string, ItemKind>> = {
	gradedsingle: "graded",
	slab: "graded",
	bulk: "lot",
	lotbulk: "lot",
	card: "single",
};

const token = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function resolveKind(raw: string): ItemKind | undefined {
	const key = token(raw);
	return (
		ITEM_KINDS.find((kind) => kind === key || token(ITEM_KIND_LABELS[kind]) === key) ?? KIND_ALIASES[key]
	);
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

/**
 * Validates one mapped row.
 *
 * @spec IO-import-validate
 *
 * The same function runs in the browser preview and again on the server for every
 * batch, so a row that fails here never reaches the database. Every problem in the
 * row is reported, keyed by column.
 */
export function validateImportRow(
	cells: Readonly<Record<string, string>>,
	context: { readonly sellerTier: Tier },
): Result<ImportedItem, readonly FieldIssue[]> {
	const issues: FieldIssue[] = [];
	const cell = (key: string) => unescapeFormula(cells[key] ?? "").trim();
	const issue = (field: string, message: string) => issues.push({ field, message });

	const kindText = cell("kind") || cell("item_type");
	const kind = kindText === "" ? undefined : resolveKind(kindText);
	if (kind === undefined) {
		issue("kind", kindText === "" ? "Kind is required" : `Kind must be one of: ${ITEM_KINDS.join(", ")}`);
	}

	const gameText = cell("game");
	const game = gameText === "" ? null : (resolveGame(gameText) ?? null);
	if (gameText !== "" && game === null) issue("game", `"${gameText}" isn't a game we know`);
	else if (game === null && kind !== undefined && gameRequired(kind)) issue("game", "Game is required");
	else if (game !== null && !game.enabled) issue("game", `${game.name} isn't open for listings yet`);

	let attributes: Attributes = {};
	if (kind !== undefined && (game !== null || !gameRequired(kind))) {
		const fields = attributeFields(kind, game);
		const validated = validateAttributes(
			kind,
			game,
			coerceAttributes(fields, Object.fromEntries(fields.map((f) => [f.key, cell(f.key)]))),
		);
		if (validated.ok) attributes = validated.value;
		else issues.push(...validated.error);
	}

	// The card or product name stands in for a blank title.
	const title = cell("title") || cell("name");
	if (title === "") issue("title", "Title is required");
	else if (title.length > MAX_TITLE_LENGTH)
		issue("title", `Title must be at most ${MAX_TITLE_LENGTH} characters`);

	const description = cell("description");
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		issue("description", `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
	}

	const sku = cell("sku");
	if (sku.length > MAX_SKU_LENGTH) issue("sku", `SKU must be at most ${MAX_SKU_LENGTH} characters`);

	let priceCents: Cents = 0;
	const priceText = cell("price");
	if (priceText === "") issue("price", "Price is required");
	else {
		const price = parseCents(priceText);
		if (!price.ok) issue("price", price.error);
		else if (price.value <= 0) issue("price", "Price must be more than $0.00");
		else priceCents = price.value;
	}

	let quantity = 1;
	const quantityText = cell("quantity");
	if (quantityText !== "") {
		if (!/^\d+$/.test(quantityText) || Number(quantityText) < 1 || Number(quantityText) > MAX_QUANTITY) {
			issue("quantity", `Quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
		} else quantity = Number(quantityText);
	}

	const offersText = cell("offers").toLowerCase() || "off";
	const offers = OFFERS_MODES.find((mode) => mode === offersText) ?? "off";
	if (offers !== offersText) issue("offers", "Offers must be off, on or min");

	let minOfferCents: Cents | null = null;
	const minText = cell("min_offer");
	if (offers === "min") {
		if (context.sellerTier !== "pro") issue("offers", "A hidden minimum offer is a Pro feature");
		if (minText === "") issue("min_offer", "Set the minimum offer, or change offers to on");
		else {
			const min = parseCents(minText);
			if (!min.ok) issue("min_offer", min.error);
			else if (min.value <= 0 || (priceCents > 0 && min.value > priceCents)) {
				issue("min_offer", "The minimum offer must be above $0.00 and at most the price");
			} else minOfferCents = min.value;
		}
	} else if (minText !== "") {
		issue("min_offer", "A minimum offer needs offers set to min");
	}

	let shippingOverrideCents: Cents | null = null;
	const shippingText = cell("shipping_override");
	if (shippingText !== "") {
		const shipping = parseCents(shippingText);
		if (shipping.ok) shippingOverrideCents = shipping.value;
		else issue("shipping_override", shipping.error);
	}

	const photos = cell("photos")
		.split(";")
		.map((name) => name.trim())
		.filter((name) => name !== "");
	if (photos.some((name) => URL_LIKE.test(name))) {
		issue("photos", "Photo links aren't supported; put the photos in the ZIP and list their file names");
	}

	if (kind !== undefined) {
		for (const violation of listingPolicyViolations({ kind, title, description, attributes })) {
			issue(violation.field, violation.message);
		}
	}

	const itemId = cell("item_id");
	if (issues.length > 0 || kind === undefined) return err(issues);
	return ok({
		itemId: itemId === "" ? null : itemId,
		sku: sku === "" ? null : sku,
		game: game?.slug ?? null,
		kind,
		title,
		description,
		priceCents,
		quantity,
		offers,
		minOfferCents,
		shippingOverrideCents,
		attributes,
		photos,
	});
}

export interface RowError {
	readonly row: number;
	readonly field: string;
	readonly message: string;
}

export interface ValidatedImport {
	readonly items: readonly { readonly row: number; readonly item: ImportedItem }[];
	readonly errors: readonly RowError[];
}

/**
 * Validates every mapped row of a file: per-row rules, the 2,000-row limit, and
 * duplicate `sku` / `item_id` values inside the file.
 *
 * @spec IO-import-validate
 */
export function validateImport(
	rows: readonly MappedRow[],
	context: { readonly sellerTier: Tier },
): Result<ValidatedImport, Rejection<"too_many_rows" | "empty_file">> {
	const filled = rows.filter((row) => Object.values(row.cells).some((cell) => cell.trim() !== ""));
	if (filled.length === 0) return reject("empty_file", "The file has no item rows");
	if (filled.length > MAX_IMPORT_ROWS) {
		return reject(
			"too_many_rows",
			`Imports are limited to ${MAX_IMPORT_ROWS} rows; this file has ${filled.length}`,
		);
	}
	const items: { row: number; item: ImportedItem }[] = [];
	const errors: RowError[] = [];
	const seenSku = new Map<string, number>();
	const seenId = new Map<string, number>();
	for (const { row, cells } of filled) {
		const result = validateImportRow(cells, context);
		if (!result.ok) {
			errors.push(...result.error.map((issue) => ({ row, ...issue })));
			continue;
		}
		const { sku, itemId } = result.value;
		const dupSku = sku === null ? undefined : seenSku.get(sku.toLowerCase());
		const dupId = itemId === null ? undefined : seenId.get(itemId);
		if (dupSku !== undefined) {
			errors.push({ row, field: "sku", message: `Row ${dupSku} already uses SKU "${sku}"` });
			continue;
		}
		if (dupId !== undefined) {
			errors.push({ row, field: "item_id", message: `Row ${dupId} already updates this item` });
			continue;
		}
		if (sku !== null) seenSku.set(sku.toLowerCase(), row);
		if (itemId !== null) seenId.set(itemId, row);
		items.push({ row, item: result.value });
	}
	return ok({ items, errors });
}

/**
 * Whether a sale can take an item import.
 *
 * @spec IO-import-target
 *
 * Only `draft` and `scheduled` sales: once a sale is live, items with entries have
 * their price and quantity locked (D40), so an import could break them.
 */
export function checkImportTarget(status: SaleStatus): Result<true, Rejection<"sale_not_importable">> {
	if (status === "draft" || status === "scheduled") return ok(true);
	return reject(
		"sale_not_importable",
		`Items can only be imported into a draft or scheduled sale (this one is ${status})`,
	);
}

/** An item already in the sale, as the importer compares it. */
export interface ExistingItem extends ImportFields {
	readonly id: string;
}

export type RowOutcome =
	| { readonly row: number; readonly outcome: "created" }
	| {
			readonly row: number;
			readonly outcome: "updated";
			readonly itemId: string;
			readonly changed: readonly string[];
	  }
	| {
			readonly row: number;
			readonly outcome: "skipped";
			readonly itemId: string;
			readonly reason: "unchanged";
	  }
	| { readonly row: number; readonly outcome: "error"; readonly field: string; readonly message: string };

export interface ImportPlan {
	readonly creates: readonly { readonly row: number; readonly item: ImportedItem }[];
	readonly updates: readonly {
		readonly row: number;
		readonly itemId: string;
		readonly item: ImportedItem;
		readonly changed: readonly string[];
	}[];
	/** Item IDs to remove; only ever non-empty when the seller ticked "remove items not in file". */
	readonly removals: readonly string[];
	readonly outcomes: readonly RowOutcome[];
	/** `limit` is null for Pro. `fits` is how many new rows the sale has room for. */
	readonly cap: { readonly limit: number | null; readonly fits: number; readonly exceeded: boolean };
}

const COMPARED: readonly (keyof ImportFields)[] = [
	"sku",
	"game",
	"kind",
	"title",
	"description",
	"priceCents",
	"quantity",
	"offers",
	"minOfferCents",
	"shippingOverrideCents",
	"attributes",
];

const canonical = (value: unknown): string =>
	value !== null && typeof value === "object"
		? JSON.stringify(
				Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
			)
		: JSON.stringify(value);

/** The fields that differ between an existing item and an imported row. */
export function changedFields(existing: ImportFields, item: ImportedItem): string[] {
	const changed: string[] = COMPARED.filter((key) => canonical(existing[key]) !== canonical(item[key]));
	if (item.photos.length > 0) changed.push("photos");
	return changed;
}

/**
 * Plans an import against the sale's current items.
 *
 * @spec IO-import-upsert
 *
 * A row matches an existing item by `item_id` (from an export), then by `sku`.
 * Matched rows update (or are skipped when nothing changed), other rows create, and
 * items missing from the file are kept unless `removeMissing` is set.
 *
 * @spec IO-import-cap
 *
 * Free sellers keep the 10-item cap: when the result would exceed it, only the
 * first `fits` new rows are planned and the rest are errors that say how many fit.
 */
export function planImport(input: {
	readonly rows: readonly { readonly row: number; readonly item: ImportedItem }[];
	readonly existing: readonly ExistingItem[];
	readonly removeMissing: boolean;
	readonly sellerTier: Tier;
}): ImportPlan {
	const byId = new Map(input.existing.map((item) => [item.id, item]));
	const bySku = new Map(
		input.existing.filter((item) => item.sku !== null).map((item) => [item.sku!.toLowerCase(), item]),
	);
	const claimed = new Map<string, number>();
	const outcomes: RowOutcome[] = [];
	const updates: ImportPlan["updates"][number][] = [];
	const pendingCreates: { row: number; item: ImportedItem }[] = [];

	for (const { row, item } of input.rows) {
		let target: ExistingItem | undefined;
		if (item.itemId !== null) {
			target = byId.get(item.itemId);
			if (target === undefined) {
				outcomes.push({
					row,
					outcome: "error",
					field: "item_id",
					message: "This item_id isn't in this sale",
				});
				continue;
			}
			const skuOwner = item.sku === null ? undefined : bySku.get(item.sku.toLowerCase());
			if (skuOwner !== undefined && skuOwner.id !== target.id) {
				outcomes.push({
					row,
					outcome: "error",
					field: "sku",
					message: `Another item already has SKU "${item.sku}"`,
				});
				continue;
			}
		} else if (item.sku !== null) {
			target = bySku.get(item.sku.toLowerCase());
		}
		if (target === undefined) {
			pendingCreates.push({ row, item });
			continue;
		}
		const earlier = claimed.get(target.id);
		if (earlier !== undefined) {
			outcomes.push({
				row,
				outcome: "error",
				field: "item_id",
				message: `Row ${earlier} already updates this item`,
			});
			continue;
		}
		claimed.set(target.id, row);
		const changed = changedFields(target, item);
		if (changed.length === 0)
			outcomes.push({ row, outcome: "skipped", itemId: target.id, reason: "unchanged" });
		else {
			updates.push({ row, itemId: target.id, item, changed });
			outcomes.push({ row, outcome: "updated", itemId: target.id, changed });
		}
	}

	const removals = input.removeMissing
		? input.existing.filter((item) => !claimed.has(item.id)).map((item) => item.id)
		: [];
	const limit = input.sellerTier === "free" ? FREE_ITEM_CAP : null;
	const kept = input.existing.length - removals.length;
	const fits = limit === null ? pendingCreates.length : Math.max(0, limit - kept);
	const creates = pendingCreates.slice(0, fits);
	for (const { row } of creates) outcomes.push({ row, outcome: "created" });
	for (const { row } of pendingCreates.slice(fits)) {
		outcomes.push({
			row,
			outcome: "error",
			field: "",
			message: `Free sales hold ${limit} items, so only ${fits} new row${fits === 1 ? "" : "s"} fit`,
		});
	}
	outcomes.sort((a, b) => a.row - b.row);
	return {
		creates,
		updates,
		removals,
		outcomes,
		cap: { limit, fits, exceeded: pendingCreates.length > fits },
	};
}
