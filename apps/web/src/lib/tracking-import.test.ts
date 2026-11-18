import { describe, expect, it } from "vitest";
import { applicableRows, buildPreview, previewPlan, type ImportableInvoice } from "./tracking-import.ts";

const invoices: ImportableInvoice[] = [
	{ id: "i1", number: "CS-1", status: "paid", tracking: null, buyerHandle: "ashk" },
	{ id: "i2", number: "CS-2", status: "sent", tracking: null, buyerHandle: "misty" },
	{
		id: "i3",
		number: "CS-3",
		status: "shipped",
		tracking: { carrier: "USPS", number: "9400111" },
		buyerHandle: "brock",
	},
];

const table = [
	["Order ID", "Tracking Number", "Carrier"],
	["CS-1", "1Z999AA10123456784", ""],
	["CS-2", "9400100000000000000001", "USPS"],
	["CS-3", "9400222", "USPS"],
	["CS-9", "9400100000000000000002", ""],
	["CS-1", "", ""],
];

describe("tracking import preview", () => {
	it("matches rows by invoice number or the tool's reference, and detects carriers [IO-tracking-match] [IO-tracking-carrier]", () => {
		const rows = buildPreview(table, invoices);
		expect(rows.map((r) => [r.row, r.invoiceId, r.carrier, r.error])).toEqual([
			[2, "i1", "UPS", null],
			[3, "i2", "USPS", null],
			[4, "i3", "USPS", null],
			[5, null, "USPS", null],
			[6, null, null, "The tracking number is missing"],
		]);
		expect(rows[0]!.matchedBy).toBe("reference");
	});

	it("previews what applying does, and only sends rows that would change something [IO-tracking-transition] [IO-tracking-replace]", () => {
		const rows = buildPreview(table, invoices);
		expect(rows.map((r) => previewPlan(r, invoices)?.action ?? null)).toEqual([
			"ship",
			"rejected",
			"rejected",
			null,
			null,
		]);
		expect(applicableRows(rows, invoices)).toEqual([
			{ row: 2, invoiceId: "i1", carrier: "UPS", number: "1Z999AA10123456784", replace: false },
		]);
		// The seller confirms the replacement and matches the unmatched row by hand.
		rows[2]!.replace = true;
		rows[3]!.invoiceId = "i1";
		expect(applicableRows(rows, invoices).map((r) => [r.row, r.replace])).toEqual([
			[2, false],
			[4, true],
			[5, false],
		]);
	});

	it("a row whose carrier can't be told waits for the seller to choose one [IO-tracking-carrier]", () => {
		const rows = buildPreview(
			[
				["invoice_number", "tracking_number"],
				["CS-1", "92001234567890123456"],
			],
			invoices,
		);
		expect(rows[0]).toMatchObject({ carrier: null, carrierCandidates: ["USPS", "FedEx"] });
		expect(applicableRows(rows, invoices)).toEqual([]);
		rows[0]!.carrier = "USPS";
		expect(applicableRows(rows, invoices)).toHaveLength(1);
	});
});
