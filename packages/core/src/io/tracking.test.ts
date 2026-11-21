import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.ts";
import {
	carrierNeedsReview,
	detectCarrier,
	matchTrackingRows,
	resolveCarrier,
	trackingUrl,
	trackingRowsFromTable,
	type TrackableInvoice,
	type TrackingRow,
} from "./tracking.ts";

describe("carrier detection [IO-tracking-carrier]", () => {
	it("detects each carrier's common formats [IO-tracking-carrier]", () => {
		expect(detectCarrier("9400 1000 0000 0000 0000 00")).toEqual({ status: "detected", carrier: "usps" });
		expect(detectCarrier("EA123456789US")).toEqual({ status: "detected", carrier: "usps" });
		expect(detectCarrier("1z999aa10123456784")).toEqual({ status: "detected", carrier: "ups" });
		expect(detectCarrier("123456789012")).toEqual({ status: "detected", carrier: "fedex" });
		expect(detectCarrier("123456789012345")).toEqual({ status: "detected", carrier: "fedex" });
		expect(detectCarrier("9612345678901234567890")).toEqual({ status: "detected", carrier: "fedex" });
		expect(detectCarrier("1234567890")).toEqual({ status: "detected", carrier: "dhl" });
		expect(detectCarrier("GM1234567890123456")).toEqual({ status: "detected", carrier: "dhl" });
	});

	it("flags numbers that fit several carriers as ambiguous [IO-tracking-carrier]", () => {
		// 20 digits starting 92: USPS IMpb, but also FedEx SmartPost.
		expect(detectCarrier("92001234567890123456")).toEqual({
			status: "ambiguous",
			candidates: ["usps", "fedex"],
		});
		expect(carrierNeedsReview(detectCarrier("92001234567890123456"))).toBe(true);
	});

	it("flags numbers that fit none as unknown [IO-tracking-carrier]", () => {
		expect(detectCarrier("ABC")).toEqual({ status: "unknown" });
		expect(detectCarrier("RR123456789DE")).toEqual({ status: "unknown" });
	});

	it("uses the file's carrier column when it's filled in [IO-tracking-carrier]", () => {
		expect(resolveCarrier("Fed Ex", "92001234567890123456")).toEqual({
			status: "given",
			carrier: "fedex",
			name: "Fed Ex",
		});
		expect(resolveCarrier(" ", "1Z999AA10123456784")).toEqual({ status: "detected", carrier: "ups" });
		const odd = resolveCarrier("Canada Post", "123");
		expect(odd).toEqual({ status: "given", carrier: null, name: "Canada Post" });
		expect(carrierNeedsReview(odd)).toBe(true);
	});
});

const invoices: TrackableInvoice[] = [
	{ id: "inv_1", invoiceNumber: "CS-1001" },
	{ id: "inv_2", invoiceNumber: "CS-1002", references: ["PS-77"] },
];

const trow = (row: number, fields: Partial<TrackingRow>): TrackingRow => ({
	row,
	invoiceNumber: null,
	orderReference: null,
	trackingNumber: "9400100000000000000000",
	carrier: null,
	...fields,
});

describe("tracking row matching [IO-tracking-match]", () => {
	it("matches by invoice number first, then the shipping tool's reference [IO-tracking-match]", () => {
		const matches = matchTrackingRows(
			[trow(2, { invoiceNumber: "#cs-1001", orderReference: "PS-77" }), trow(3, { orderReference: "ps-77" })],
			invoices,
		);
		expect(matches).toMatchObject([
			{ row: 2, status: "matched", invoiceId: "inv_1", by: "invoice_number" },
			{ row: 3, status: "matched", invoiceId: "inv_2", by: "reference" },
		]);
	});

	it("accepts an invoice number echoed back as the order reference (Pirate Ship's Order ID) [IO-tracking-match]", () => {
		expect(matchTrackingRows([trow(2, { orderReference: "CS-1002" })], invoices)).toMatchObject([
			{ status: "matched", invoiceId: "inv_2", by: "reference" },
		]);
	});

	it("leaves rows it can't match for the seller, with the carrier worked out [IO-tracking-match]", () => {
		expect(matchTrackingRows([trow(2, { invoiceNumber: "CS-9999" })], invoices)).toEqual([
			{
				row: 2,
				status: "unmatched",
				trackingNumber: "9400100000000000000000",
				carrier: { status: "detected", carrier: "usps" },
			},
		]);
	});

	it("rejects missing tracking numbers and a second row for the same invoice [IO-tracking-match]", () => {
		const matches = matchTrackingRows(
			[
				trow(2, { invoiceNumber: "CS-1001", trackingNumber: " " }),
				trow(3, { invoiceNumber: "CS-1001" }),
				trow(4, { invoiceNumber: "CS-1001" }),
			],
			invoices,
		);
		expect(matches.map((m) => m.status)).toEqual(["error", "matched", "error"]);
		expect(matches[2]).toEqual({
			row: 4,
			status: "error",
			message: "Row 3 already has tracking for this invoice",
		});
	});

	it("reads rows from a Pirate Ship-style file [IO-tracking-match]", () => {
		const table = parseCsv(
			"Order ID,Tracking Number,Carrier,Name\r\nCS-1001,1Z999AA10123456784,,Ash\r\n,,,\r\n'=CS-1002,EA123456789US,USPS,Misty\r\n",
		);
		expect(trackingRowsFromTable(table)).toEqual([
			{
				row: 2,
				invoiceNumber: null,
				orderReference: "CS-1001",
				trackingNumber: "1Z999AA10123456784",
				carrier: null,
			},
			{
				row: 4,
				invoiceNumber: null,
				orderReference: "=CS-1002",
				trackingNumber: "EA123456789US",
				carrier: "USPS",
			},
		]);
	});
});

describe("tracking links [IO-tracking-link]", () => {
	it("links each known carrier's tracking page [IO-tracking-link]", () => {
		expect(trackingUrl("USPS", "9400 1000 0000 0000 0000 00")).toBe(
			"https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000",
		);
		expect(trackingUrl("UPS", "1z999aa10123456784")).toBe(
			"https://www.ups.com/track?tracknum=1Z999AA10123456784",
		);
		expect(trackingUrl("FedEx", "123456789012")).toBe(
			"https://www.fedex.com/fedextrack/?trknbr=123456789012",
		);
		expect(trackingUrl("DHL", "1234567890")).toBe(
			"https://www.dhl.com/us-en/home/tracking.html?submit=1&tracking-id=1234567890",
		);
	});

	it("accepts the carriers' other names [IO-tracking-link]", () => {
		expect(trackingUrl("United States Postal Service", "EA123456789US")).toContain("usps.com");
		expect(trackingUrl("Federal Express", "123456789012")).toContain("fedex.com");
	});

	it("detects the carrier when the name is blank [IO-tracking-link]", () => {
		expect(trackingUrl("", "1Z999AA10123456784")).toContain("ups.com");
	});

	it("gives no link for an unknown carrier, an ambiguous number or a blank one [IO-tracking-link]", () => {
		expect(trackingUrl("OnTrac", "C12345678901234")).toBeNull();
		expect(trackingUrl("", "92001234567890123456")).toBeNull();
		expect(trackingUrl("USPS", "  ")).toBeNull();
	});
});
