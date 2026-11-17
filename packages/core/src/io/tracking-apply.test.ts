import { describe, expect, it } from "vitest";
import { invoiceNumberLabel, type InvoiceStatus } from "../invoice.ts";
import { carrierName, matchTrackingRows, planTracking, resolveCarrier } from "./tracking.ts";

const target = (status: InvoiceStatus, number: string | null = null) => ({
	status,
	tracking: number === null ? null : { carrier: "USPS", number },
});

describe("applying tracking rows", () => {
	it("only paid invoices move to shipped; every other status is rejected with a reason [IO-tracking-transition]", () => {
		expect(planTracking(target("paid"), "9400111", false)).toEqual({ action: "ship" });
		for (const status of ["draft", "sent", "overdue", "buyer_paid"] as const) {
			const plan = planTracking(target(status), "9400111", true);
			expect(plan).toMatchObject({ action: "rejected", code: "not_paid" });
			expect(plan.action === "rejected" && plan.message).toBeTruthy();
		}
		expect(planTracking(target("completed", "9400111"), "9400222", true)).toMatchObject({
			action: "rejected",
			code: "already_complete",
		});
		expect(planTracking(target("cancelled"), "9400222", true)).toMatchObject({
			action: "rejected",
			code: "cancelled",
		});
	});

	it("a different number on a shipped invoice needs the replace confirmation [IO-tracking-replace]", () => {
		expect(planTracking(target("shipped", "9400 111"), "9400111", false)).toEqual({ action: "unchanged" });
		expect(planTracking(target("shipped", "9400111"), "9400222", false)).toMatchObject({
			action: "rejected",
			code: "replace_unconfirmed",
		});
		expect(planTracking(target("shipped", "9400111"), "9400222", true)).toEqual({
			action: "replace",
			previous: "9400111",
		});
		// Shipped without tracking (under the threshold): adding a number is still a confirmed replacement.
		expect(planTracking(target("shipped"), "9400222", false)).toMatchObject({ code: "replace_unconfirmed" });
		expect(planTracking(target("shipped"), "9400222", true)).toEqual({ action: "replace", previous: "" });
	});

	it("invoice numbers as exported match back to their invoice [IO-tracking-match]", () => {
		const label = invoiceNumberLabel(7, "inv_1");
		expect(label).toBe("CS-7");
		expect(invoiceNumberLabel(null, "inv_1")).toBe("inv_1");
		const [match] = matchTrackingRows(
			[
				{
					row: 2,
					invoiceNumber: "#cs-7",
					orderReference: null,
					trackingNumber: "1Z999AA10123456784",
					carrier: null,
				},
			],
			[{ id: "inv_1", invoiceNumber: label }],
		);
		expect(match).toMatchObject({ status: "matched", invoiceId: "inv_1" });
	});

	it("names the carrier to store, or asks the seller when it's ambiguous or unknown [IO-tracking-carrier]", () => {
		expect(carrierName(resolveCarrier(null, "1Z999AA10123456784"))).toBe("UPS");
		expect(carrierName(resolveCarrier("united parcel service", "x"))).toBe("UPS");
		expect(carrierName(resolveCarrier("Royal Mail", "x"))).toBe("Royal Mail");
		expect(carrierName(resolveCarrier(null, "92001234567890123456"))).toBeNull();
		expect(carrierName(resolveCarrier(null, "nope"))).toBeNull();
	});
});
