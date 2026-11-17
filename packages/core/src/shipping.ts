import { err, ok, type Result } from "./common.ts";
import type { ShippingOption } from "./invoice.ts";
import { parseCents } from "./io/cells.ts";
import type { Cents } from "./money.ts";

/**
 * The seller's shipping menu (D15), stored in `sales.shipping` as
 * `[{ id, label, priceCents, tracked }]` and read by the engine when a buyer pays.
 * One flat price per invoice; per-item and "free over $X" pricing come later (PLAN §3).
 */

export const SHIPPING_MENU_MAX = 10;
export const SHIPPING_LABEL_MAX = 60;
/** $100: anything above is almost certainly a typo for a flat per-invoice price. */
export const SHIPPING_PRICE_MAX: Cents = 10_000;

/** The options a new menu starts from: one untracked, one tracked. */
export const SUGGESTED_SHIPPING: readonly ShippingOption[] = [
	{ id: "pwe", label: "Plain white envelope (untracked)", priceCents: 150, tracked: false },
	{ id: "ground", label: "USPS Ground Advantage (tracked)", priceCents: 550, tracked: true },
];

/** One row of the menu editor, as the form sends it. */
export interface ShippingOptionInput {
	/** Empty for a new row. */
	readonly id: string;
	readonly label: string;
	readonly price: string;
	readonly tracked: boolean;
}

export interface ShippingMenuError {
	/** The row's position in the form (0-based); -1 for the whole menu. */
	readonly row: number;
	readonly field: "label" | "price" | "menu";
	readonly message: string;
}

const ID = /^[a-z0-9_-]{1,32}$/;

const fields = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};

/**
 * The stored menu (parsed JSON: an array, or `{ options: [...] }`). Entries that
 * aren't well-formed are dropped, so a bad row never breaks an invoice.
 */
export function shippingMenuFrom(value: unknown): ShippingOption[] {
	const options: unknown = Array.isArray(value) ? value : fields(value)["options"];
	const list: readonly unknown[] = Array.isArray(options) ? options : [];
	const menu: ShippingOption[] = [];
	for (const entry of list) {
		const { id, label, priceCents, tracked } = fields(entry);
		if (
			typeof id === "string" &&
			typeof label === "string" &&
			typeof priceCents === "number" &&
			Number.isSafeInteger(priceCents) &&
			priceCents >= 0
		) {
			menu.push({ id, label, priceCents, tracked: tracked === true });
		}
	}
	return menu;
}

/**
 * Validates the menu editor's rows. Blank rows (no label, no price) are dropped;
 * kept rows keep their ID, so a buyer's chosen option still resolves after an edit.
 *
 * @spec SM-6-shipping-menu — 1 to 10 options, each with a label (≤ 60 characters) and a
 * price of $0–$100 in cents; untracked options are later hidden by the threshold rules.
 */
export function validateShippingMenu(
	rows: readonly ShippingOptionInput[],
	newId: () => string,
): Result<ShippingOption[], ShippingMenuError[]> {
	const errors: ShippingMenuError[] = [];
	const menu: ShippingOption[] = [];
	const seen = new Set<string>();
	rows.forEach((row, index) => {
		const label = row.label.trim().replace(/\s+/g, " ");
		const priceText = row.price.trim();
		if (label === "" && priceText === "") return;
		if (label === "") errors.push({ row: index, field: "label", message: "Name this option" });
		else if (label.length > SHIPPING_LABEL_MAX)
			errors.push({ row: index, field: "label", message: `Use at most ${SHIPPING_LABEL_MAX} characters` });
		const price = parseCents(priceText === "" ? "0" : priceText);
		if (!price.ok) errors.push({ row: index, field: "price", message: price.error });
		else if (price.value > SHIPPING_PRICE_MAX)
			errors.push({ row: index, field: "price", message: "Shipping can be at most $100.00" });
		let id = row.id.trim();
		if (!ID.test(id) || seen.has(id)) id = newId();
		seen.add(id);
		if (price.ok) menu.push({ id, label, priceCents: price.value, tracked: row.tracked });
	});
	if (menu.length === 0 && errors.length === 0)
		errors.push({ row: -1, field: "menu", message: "Add at least one shipping option" });
	if (menu.length > SHIPPING_MENU_MAX)
		errors.push({ row: -1, field: "menu", message: `Offer at most ${SHIPPING_MENU_MAX} options` });
	return errors.length > 0 ? err(errors) : ok(menu);
}
