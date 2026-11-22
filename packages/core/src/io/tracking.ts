import type { InvoiceStatus } from "../invoice.ts";
import { isBlankRow } from "./csv.ts";
import { unescapeFormula } from "./cells.ts";
import { normalizeHeader } from "./mapping.ts";

/**
 * Tracking re-import (PLAN §3c.3): match rows from a shipping tool's file to
 * invoices and work out the carrier. Applying (paid → shipped, replace confirmation)
 * is the engine's job (IO-tracking-transition, IO-tracking-replace).
 */

export const CARRIERS = ["usps", "ups", "fedex", "dhl"] as const;
export type Carrier = (typeof CARRIERS)[number];

export const CARRIER_NAMES: Readonly<Record<Carrier, string>> = {
	usps: "USPS",
	ups: "UPS",
	fedex: "FedEx",
	dhl: "DHL",
};

export type CarrierResult =
	| { readonly status: "detected"; readonly carrier: Carrier }
	/** The seller's file named the carrier; `carrier` is null for one we don't know. */
	| { readonly status: "given"; readonly carrier: Carrier | null; readonly name: string }
	| { readonly status: "ambiguous"; readonly candidates: readonly Carrier[] }
	| { readonly status: "unknown" };

/** Uppercase, without spaces or dashes (tools print numbers in groups). */
export const normalizeTrackingNumber = (value: string): string => value.replace(/[\s-]/g, "").toUpperCase();

/**
 * Tracking number formats. TODO verify against each carrier's current documentation;
 * these cover the common domestic and express formats.
 */
const FORMATS: Readonly<Record<Carrier, readonly RegExp[]>> = {
	// IMpb (20 or 22 digits starting 91–95, or 26/30/34 with a routing prefix) and S10 ending in US.
	usps: [/^9[1-5]\d{18}$/, /^9[1-5]\d{20}$/, /^420\d{5}9[1-5]\d{20}$/, /^[A-Z]{2}\d{9}US$/],
	ups: [/^1Z[0-9A-Z]{16}$/, /^T\d{10}$/, /^K\d{10}$/],
	// Express (12), Ground (15), Ground 96 (22) and SmartPost (20, which USPS delivers).
	fedex: [/^\d{12}$/, /^\d{15}$/, /^96\d{20}$/, /^\d{20}$/],
	// Express (10), eCommerce (GM… and JJD / JVGL).
	dhl: [/^\d{10}$/, /^GM\d{16,18}$/, /^(?:JJD|JVGL)\d{8,20}$/],
};

/**
 * Detects the carrier from a tracking number's format.
 *
 * @spec IO-tracking-carrier
 *
 * A number that fits exactly one carrier is detected; one that fits several (a
 * 20-digit number starting 92 is both USPS IMpb and FedEx SmartPost) is ambiguous,
 * and one that fits none is unknown. Both are flagged for the seller.
 */
export function detectCarrier(trackingNumber: string): CarrierResult {
	const number = normalizeTrackingNumber(trackingNumber);
	const candidates = CARRIERS.filter((carrier) => FORMATS[carrier].some((format) => format.test(number)));
	if (candidates.length === 1) return { status: "detected", carrier: candidates[0]! };
	if (candidates.length > 1) return { status: "ambiguous", candidates };
	return { status: "unknown" };
}

const CARRIER_ALIASES: Readonly<Record<string, Carrier>> = {
	usps: "usps",
	unitedstatespostalservice: "usps",
	postalservice: "usps",
	ups: "ups",
	unitedparcelservice: "ups",
	fedex: "fedex",
	federalexpress: "fedex",
	dhl: "dhl",
	dhlexpress: "dhl",
	dhlecommerce: "dhl",
};

/**
 * The carrier for a row: the file's carrier column when filled in, else detection.
 *
 * @spec IO-tracking-carrier
 */
export function resolveCarrier(given: string | null, trackingNumber: string): CarrierResult {
	const name = given?.trim() ?? "";
	if (name === "") return detectCarrier(trackingNumber);
	const key = name.toLowerCase().replace(/[^a-z]/g, "");
	return { status: "given", carrier: CARRIER_ALIASES[key] ?? null, name };
}

/** Whether the seller has to look at the carrier before applying. */
export const carrierNeedsReview = (result: CarrierResult): boolean =>
	result.status === "ambiguous" ||
	result.status === "unknown" ||
	(result.status === "given" && result.carrier === null);

export interface TrackingRow {
	readonly row: number;
	readonly invoiceNumber: string | null;
	/** The shipping tool's order reference (Pirate Ship echoes "Order ID"). */
	readonly orderReference: string | null;
	readonly trackingNumber: string;
	readonly carrier: string | null;
}

export interface TrackableInvoice {
	readonly id: string;
	readonly invoiceNumber: string;
	/** Other references a shipping tool may echo back for this invoice. */
	readonly references?: readonly string[];
}

export type TrackingMatch =
	| {
			readonly row: number;
			readonly status: "matched";
			readonly invoiceId: string;
			readonly by: "invoice_number" | "reference";
			readonly trackingNumber: string;
			readonly carrier: CarrierResult;
	  }
	| {
			readonly row: number;
			readonly status: "unmatched";
			readonly trackingNumber: string;
			readonly carrier: CarrierResult;
	  }
	| { readonly row: number; readonly status: "error"; readonly message: string };

const refKey = (value: string) => value.trim().replace(/^#/, "").toLowerCase();

/**
 * Matches tracking rows to invoices.
 *
 * @spec IO-tracking-match
 *
 * By invoice number first, then by the shipping tool's order reference (checked
 * against invoice numbers and each invoice's known references); otherwise the row is
 * unmatched and the seller matches it by hand. A row without a tracking number is an
 * error, and so is a second row for an invoice already matched in the same file.
 */
export function matchTrackingRows(
	rows: readonly TrackingRow[],
	invoices: readonly TrackableInvoice[],
): TrackingMatch[] {
	const byNumber = new Map(invoices.map((invoice) => [refKey(invoice.invoiceNumber), invoice]));
	const byReference = new Map<string, TrackableInvoice>();
	for (const invoice of invoices) {
		byReference.set(refKey(invoice.invoiceNumber), invoice);
		for (const reference of invoice.references ?? []) byReference.set(refKey(reference), invoice);
	}
	const matchedRow = new Map<string, number>();
	return rows.map((row): TrackingMatch => {
		const trackingNumber = normalizeTrackingNumber(row.trackingNumber);
		if (trackingNumber === "")
			return { row: row.row, status: "error", message: "The tracking number is missing" };
		const carrier = resolveCarrier(row.carrier, trackingNumber);
		let invoice: TrackableInvoice | undefined;
		let by: "invoice_number" | "reference" = "invoice_number";
		if (row.invoiceNumber !== null && row.invoiceNumber.trim() !== "")
			invoice = byNumber.get(refKey(row.invoiceNumber));
		if (invoice === undefined && row.orderReference !== null && row.orderReference.trim() !== "") {
			invoice = byReference.get(refKey(row.orderReference));
			by = "reference";
		}
		if (invoice === undefined) return { row: row.row, status: "unmatched", trackingNumber, carrier };
		const earlier = matchedRow.get(invoice.id);
		if (earlier !== undefined) {
			return {
				row: row.row,
				status: "error",
				message: `Row ${earlier} already has tracking for this invoice`,
			};
		}
		matchedRow.set(invoice.id, row.row);
		return { row: row.row, status: "matched", invoiceId: invoice.id, by, trackingNumber, carrier };
	});
}

const TRACKING_HEADERS: Readonly<Record<string, keyof Omit<TrackingRow, "row">>> = {
	invoice_number: "invoiceNumber",
	invoice: "invoiceNumber",
	invoice_no: "invoiceNumber",
	order_reference: "orderReference",
	order_id: "orderReference",
	order_number: "orderReference",
	order: "orderReference",
	reference: "orderReference",
	tracking_number: "trackingNumber",
	tracking: "trackingNumber",
	tracking_no: "trackingNumber",
	carrier: "carrier",
};

/** Reads tracking rows from a parsed table (header row first), skipping blank rows. */
export function trackingRowsFromTable(table: readonly (readonly string[])[]): TrackingRow[] {
	const [headers = [], ...data] = table;
	const columns = headers.map((header) => TRACKING_HEADERS[normalizeHeader(header)]);
	const out: TrackingRow[] = [];
	data.forEach((cells, index) => {
		if (isBlankRow(cells)) return;
		const row: {
			invoiceNumber: string | null;
			orderReference: string | null;
			trackingNumber: string;
			carrier: string | null;
		} = {
			invoiceNumber: null,
			orderReference: null,
			trackingNumber: "",
			carrier: null,
		};
		columns.forEach((field, column) => {
			const value = unescapeFormula(cells[column] ?? "").trim();
			if (field !== undefined && value !== "") row[field] = value;
		});
		out.push({ row: index + 2, ...row });
	});
	return out;
}

// ---------------------------------------------------------------------------
// Applying (the engine runs this per matched row, under the sale's invoices lock)

/** What the invoice looks like to the tracking import. */
export interface TrackingTarget {
	readonly status: InvoiceStatus;
	readonly tracking: { readonly carrier: string; readonly number: string } | null;
}

export type TrackingRejectCode = "not_paid" | "replace_unconfirmed" | "already_complete" | "cancelled";

export type TrackingPlan =
	/** `paid` → `shipped` with this tracking. */
	| { readonly action: "ship" }
	/** Shipped with another number, and the seller confirmed the replacement. */
	| { readonly action: "replace"; readonly previous: string }
	/** Shipped with the same number: nothing to do. */
	| { readonly action: "unchanged" }
	| { readonly action: "rejected"; readonly code: TrackingRejectCode; readonly message: string };

const NOT_PAID: Partial<Record<InvoiceStatus, string>> = {
	draft: "This invoice hasn't been sent yet",
	sent: "The buyer hasn't paid yet",
	overdue: "The buyer hasn't paid yet",
	buyer_paid: "Confirm the payment before shipping",
};

/**
 * What a tracking row does to its invoice.
 *
 * @spec IO-tracking-transition — only `paid` invoices move to `shipped`; every other
 * status is rejected with the reason.
 * @spec IO-tracking-replace — a different number on a shipped invoice needs the seller's
 * "replace" confirmation (the engine logs it); the same number again is a no-op.
 */
export function planTracking(target: TrackingTarget, trackingNumber: string, replace: boolean): TrackingPlan {
	switch (target.status) {
		case "paid":
			return { action: "ship" };
		case "shipped": {
			const previous = target.tracking?.number ?? "";
			if (normalizeTrackingNumber(previous) === normalizeTrackingNumber(trackingNumber))
				return { action: "unchanged" };
			if (!replace) {
				return {
					action: "rejected",
					code: "replace_unconfirmed",
					message:
						previous === ""
							? "This order shipped without tracking. Confirm to add this number"
							: `This order already has tracking ${previous}. Confirm to replace it`,
				};
			}
			return { action: "replace", previous };
		}
		case "completed":
			return { action: "rejected", code: "already_complete", message: "This order is already complete" };
		case "cancelled":
			return { action: "rejected", code: "cancelled", message: "This invoice was cancelled" };
		default:
			return {
				action: "rejected",
				code: "not_paid",
				message: NOT_PAID[target.status] ?? "This invoice can't ship yet",
			};
	}
}

/** The carrier name to store for a row, or null when the seller has to choose one. */
export function carrierName(result: CarrierResult): string | null {
	if (result.status === "detected") return CARRIER_NAMES[result.carrier];
	if (result.status === "given") return result.carrier === null ? result.name : CARRIER_NAMES[result.carrier];
	return null;
}

/** Each carrier's public tracking page; the number goes in the query string. */
const TRACKING_PAGES: Readonly<Record<Carrier, string>> = {
	usps: "https://tools.usps.com/go/TrackConfirmAction?tLabels=",
	ups: "https://www.ups.com/track?tracknum=",
	fedex: "https://www.fedex.com/fedextrack/?trknbr=",
	dhl: "https://www.dhl.com/us-en/home/tracking.html?submit=1&tracking-id=",
};

/**
 * The carrier's tracking page for a shipped invoice's tracking.
 *
 * @spec IO-tracking-link
 *
 * The stored carrier name decides the page (USPS, UPS, FedEx or DHL, by any of their
 * usual names); a blank one falls back to detection from the number. A carrier we
 * don't know, or a number that fits several, gets no link.
 */
export function trackingUrl(carrier: string, trackingNumber: string): string | null {
	const number = normalizeTrackingNumber(trackingNumber);
	if (number === "") return null;
	const result = resolveCarrier(carrier, number);
	const known = result.status === "detected" || result.status === "given" ? result.carrier : null;
	return known === null ? null : TRACKING_PAGES[known] + encodeURIComponent(number);
}
