import { attributeFields, formatAttribute, type ItemKind } from "../attributes.ts";
import type { Millis } from "../common.ts";
import { gameBySlug } from "../games.ts";
import type { InvoiceStatus } from "../invoice.ts";
import type { Cents } from "../money.ts";
import { escapeFormula, formatCentsPlain } from "./cells.ts";
import { CORE_COLUMNS, EXPORT_ONLY_COLUMNS } from "./columns.ts";
import type { ExistingItem } from "./import.ts";

/**
 * Export row builders (PLAN §3c.2). Each returns a table of formula-escaped strings
 * (header row first) that `encodeCsv` or an XLSX writer turns into a file.
 */

export interface Table {
	readonly headers: readonly string[];
	readonly rows: readonly (readonly string[])[];
}

const escapeTable = (headers: readonly string[], rows: readonly (readonly string[])[]): Table => ({
	headers,
	rows: rows.map((row) => row.map(escapeFormula)),
});

const money = (cents: Cents | null) => (cents === null ? "" : formatCentsPlain(cents));
const date = (at: Millis | null) => (at === null ? "" : new Date(at).toISOString());

// ---------------------------------------------------------------------------
// Sale items

export interface ExportItem extends ExistingItem {
	readonly status: string;
	readonly winnerHandle: string | null;
	readonly finalPriceCents: Cents | null;
}

/** Attribute columns for a set of items: each item's fields in schema order, deduplicated. */
function attributeColumns(
	items: readonly { readonly kind: ItemKind; readonly game: string | null }[],
): string[] {
	const keys = new Set<string>();
	for (const item of items) {
		const game = item.game === null ? null : (gameBySlug(item.game) ?? null);
		if (game === null && item.kind !== "accessory") continue;
		for (const spec of attributeFields(item.kind, game)) keys.add(spec.key);
	}
	return [...keys];
}

/**
 * The sale items export. It uses the import template's columns plus `item_id`,
 * status, winner handle and final price, so it can be re-imported unchanged
 * (IO-export-roundtrip). Market prices are never part of it (D64).
 */
export function itemsExport(items: readonly ExportItem[]): Table {
	const attributes = attributeColumns(items);
	const headers = [...EXPORT_ONLY_COLUMNS, ...CORE_COLUMNS.map((c) => c.header), ...attributes];
	const rows = items.map((item) => {
		const core: Record<string, string> = {
			item_id: item.id,
			status: item.status,
			winner_handle: item.winnerHandle ?? "",
			final_price: money(item.finalPriceCents),
			sku: item.sku ?? "",
			game: item.game ?? "",
			kind: item.kind,
			title: item.title,
			description: item.description,
			price: money(item.priceCents),
			quantity: String(item.quantity),
			offers: item.offers,
			min_offer: money(item.minOfferCents),
			shipping_override: money(item.shippingOverrideCents),
			photos: "",
		};
		return headers.map((header) => core[header] ?? formatAttribute(item.attributes[header]));
	});
	return escapeTable(headers, rows);
}

// ---------------------------------------------------------------------------
// Orders and shipping (buyer data: IO-export-privacy)

export interface ShippingAddress {
	readonly name: string;
	readonly line1: string;
	readonly line2: string | null;
	readonly city: string;
	readonly region: string;
	readonly postalCode: string;
	readonly country: string;
}

/**
 * The buyer as the database knows them. Email and phone are here on purpose: the
 * export builders receive whole records and must project them away.
 */
export interface BuyerRecord {
	readonly id: string;
	readonly handle: string;
	readonly displayName: string;
	readonly email?: string | null;
	readonly phone?: string | null;
}

export interface OrderLine {
	readonly title: string;
	readonly sku: string | null;
	readonly amountCents: Cents;
	/** Taken back after payment (SM-6-rescind-line): no longer a won item. */
	readonly refundOwed: boolean;
}

export interface OrderSource {
	readonly invoiceNumber: string;
	readonly status: InvoiceStatus;
	readonly buyer: BuyerRecord;
	/** The address snapshot taken at payment; null before the buyer pays. */
	readonly shippingAddress: ShippingAddress | null;
	readonly lines: readonly OrderLine[];
	readonly shippingOptionLabel: string | null;
	readonly shippingCents: Cents;
	readonly adjustmentCents: number;
	readonly paidAt: Millis | null;
	readonly shippedAt: Millis | null;
	readonly tracking: { readonly carrier: string; readonly number: string } | null;
}

/** The orders export columns. There is deliberately no email or phone column. */
export const ORDER_COLUMNS = [
	"invoice_number",
	"buyer_handle",
	"buyer_display_name",
	"ship_name",
	"ship_line1",
	"ship_line2",
	"ship_city",
	"ship_region",
	"ship_postal_code",
	"ship_country",
	"item",
	"sku",
	"price",
	"shipping_option",
	"shipping",
	"invoice_total",
	"status",
	"paid_at",
	"shipped_at",
	"carrier",
	"tracking_number",
] as const;

const wonLines = (order: OrderSource) => order.lines.filter((line) => !line.refundOwed);

const orderTotal = (order: OrderSource) =>
	Math.max(
		0,
		wonLines(order).reduce((sum, line) => sum + line.amountCents, 0) +
			order.shippingCents +
			order.adjustmentCents,
	);

const exportable = (order: OrderSource) => order.status !== "cancelled" && wonLines(order).length > 0;

function addressCells(address: ShippingAddress | null): string[] {
	if (address === null) return ["", "", "", "", "", "", ""];
	return [
		address.name,
		address.line1,
		address.line2 ?? "",
		address.city,
		address.region,
		address.postalCode,
		address.country,
	];
}

/**
 * The orders / buyers export: one row per won invoice line.
 *
 * @spec IO-export-privacy
 *
 * Buyer data is limited to the handle, display name and shipping address. Fields are
 * picked one by one (never spread), so an email or phone on the buyer record can't
 * reach the file. Cancelled invoices and refund-owed lines aren't won items and are
 * left out.
 */
export function ordersExport(orders: readonly OrderSource[]): Table {
	const rows: string[][] = [];
	for (const order of orders.filter(exportable)) {
		for (const line of wonLines(order)) {
			rows.push([
				order.invoiceNumber,
				order.buyer.handle,
				order.buyer.displayName,
				...addressCells(order.shippingAddress),
				line.title,
				line.sku ?? "",
				money(line.amountCents),
				order.shippingOptionLabel ?? "",
				money(order.shippingCents),
				money(orderTotal(order)),
				order.status,
				date(order.paidAt),
				date(order.shippedAt),
				order.tracking?.carrier ?? "",
				order.tracking?.number ?? "",
			]);
		}
	}
	return escapeTable(ORDER_COLUMNS, rows);
}

/** Orders ready for a label: paid, not shipped, with an address. */
const readyToShip = (order: OrderSource) =>
	exportable(order) && order.status === "paid" && order.shippingAddress !== null;

const itemSummary = (order: OrderSource) =>
	wonLines(order)
		.map((line) => line.title)
		.join("; ");

/**
 * Pirate Ship's spreadsheet import layout, one row per shipment. "Order ID" is the
 * invoice number, which Pirate Ship echoes back for the tracking re-import.
 * TODO verify: header names against Pirate Ship's current import template.
 *
 * @spec IO-export-privacy
 */
export function pirateShipExport(orders: readonly OrderSource[]): Table {
	const headers = [
		"Order ID",
		"Name",
		"Company",
		"Address",
		"Address Line 2",
		"City",
		"State",
		"Zipcode",
		"Country",
		"Description",
	];
	const rows = orders.filter(readyToShip).map((order) => {
		const a = order.shippingAddress!;
		return [
			order.invoiceNumber,
			a.name,
			"",
			a.line1,
			a.line2 ?? "",
			a.city,
			a.region,
			a.postalCode,
			a.country,
			itemSummary(order),
		];
	});
	return escapeTable(headers, rows);
}

/**
 * The generic shipping layout for other label tools.
 *
 * @spec IO-export-privacy
 */
export function genericShippingExport(orders: readonly OrderSource[]): Table {
	const headers = [
		"order_reference",
		"name",
		"address_line1",
		"address_line2",
		"city",
		"region",
		"postal_code",
		"country",
		"item_count",
		"items",
		"shipping_option",
	];
	const rows = orders.filter(readyToShip).map((order) => {
		const a = order.shippingAddress!;
		return [
			order.invoiceNumber,
			a.name,
			a.line1,
			a.line2 ?? "",
			a.city,
			a.region,
			a.postalCode,
			a.country,
			String(wonLines(order).length),
			itemSummary(order),
			order.shippingOptionLabel ?? "",
		];
	});
	return escapeTable(headers, rows);
}

/** The table as rows for `encodeCsv`. */
export const tableRows = (table: Table): (readonly string[])[] => [table.headers, ...table.rows];
