import {
	CARRIER_NAMES,
	carrierName,
	matchTrackingRows,
	planTracking,
	trackingRowsFromTable,
	type InvoiceStatus,
	type TrackingPlan,
	type Tracking,
} from "@claimsale/core";

/**
 * The tracking re-import preview (PLAN §3c.3), built in the browser from the parsed
 * file and the sale's invoices: each row's match, carrier and what applying would do.
 * The seller can match unmatched rows by hand, pick a carrier the number didn't tell,
 * and confirm replacements. The engine re-checks everything when the rows are applied.
 */

export interface ImportableInvoice {
	readonly id: string;
	readonly number: string;
	readonly status: InvoiceStatus;
	readonly tracking: Tracking | null;
	readonly buyerHandle: string | null;
}

export interface PreviewRow {
	readonly row: number;
	/** Null while unmatched; the seller can pick one. */
	invoiceId: string | null;
	readonly trackingNumber: string;
	/** Null when the seller has to choose (ambiguous or unknown format). */
	carrier: string | null;
	readonly carrierCandidates: readonly string[];
	replace: boolean;
	readonly error: string | null;
	readonly matchedBy: "invoice_number" | "reference" | null;
}

export function buildPreview(
	table: readonly (readonly string[])[],
	invoices: readonly ImportableInvoice[],
): PreviewRow[] {
	const rows = trackingRowsFromTable(table);
	const matches = matchTrackingRows(
		rows,
		invoices.map((i) => ({ id: i.id, invoiceNumber: i.number })),
	);
	return matches.map((match): PreviewRow => {
		if (match.status === "error") {
			return {
				row: match.row,
				invoiceId: null,
				trackingNumber: rows.find((r) => r.row === match.row)?.trackingNumber ?? "",
				carrier: null,
				carrierCandidates: [],
				replace: false,
				error: match.message,
				matchedBy: null,
			};
		}
		const candidates =
			match.carrier.status === "ambiguous"
				? match.carrier.candidates.map((c) => CARRIER_NAMES[c])
				: Object.values(CARRIER_NAMES);
		return {
			row: match.row,
			invoiceId: match.status === "matched" ? match.invoiceId : null,
			trackingNumber: match.trackingNumber,
			carrier: carrierName(match.carrier),
			carrierCandidates: candidates,
			replace: false,
			error: null,
			matchedBy: match.status === "matched" ? match.by : null,
		};
	});
}

/**
 * What applying a row would do, for the preview.
 *
 * @spec IO-tracking-transition
 * @spec IO-tracking-replace
 */
export function previewPlan(row: PreviewRow, invoices: readonly ImportableInvoice[]): TrackingPlan | null {
	if (row.error !== null || row.invoiceId === null) return null;
	const invoice = invoices.find((i) => i.id === row.invoiceId);
	return invoice ? planTracking(invoice, row.trackingNumber, row.replace) : null;
}

/** The rows ready to send to the engine: matched, with a carrier, not rejected. */
export function applicableRows(rows: readonly PreviewRow[], invoices: readonly ImportableInvoice[]) {
	return rows.flatMap((row) => {
		const plan = previewPlan(row, invoices);
		if (plan === null || row.carrier === null || row.invoiceId === null) return [];
		if (plan.action === "rejected" || plan.action === "unchanged") return [];
		return [
			{
				row: row.row,
				invoiceId: row.invoiceId,
				carrier: row.carrier,
				number: row.trackingNumber,
				replace: row.replace,
			},
		];
	});
}
