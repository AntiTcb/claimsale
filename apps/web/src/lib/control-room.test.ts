import { RESCIND_REASON_CODES } from "@claimsale/core";
import { describe, expect, it } from "vitest";
import {
	buyerLabel,
	describeRecord,
	formatRemaining,
	RESCIND_REASON_OPTIONS,
	type BuyerSummary,
} from "./control-room.ts";

const record = {
	completedPurchases: 12,
	nonPay: 0,
	paymentReversed: 0,
	takebacks: 0,
	violations: 0,
	proRescinds: 0,
	memberSince: Date.UTC(2025, 10, 3),
};

describe("control room wording", () => {
	it("[REP-buyer-record] describes a record at a glance, listing only marks that exist", () => {
		expect(describeRecord(record)).toBe("12 completed · member since Nov 2025");
		expect(
			describeRecord({
				...record,
				nonPay: 1,
				paymentReversed: 2,
				takebacks: 1,
				violations: 3,
				proRescinds: 2,
			}),
		).toBe(
			"12 completed · 1 non-pay · 2 payment reversed · 1 take-back · 3 violations · 2 Pro rescinds · member since Nov 2025",
		);
		expect(describeRecord({ ...record, takebacks: 2, violations: 1, proRescinds: 1 })).toContain(
			"2 take-backs · 1 violation · 1 Pro rescind",
		);
	});

	it("formats countdowns from seconds to days", () => {
		expect(formatRemaining(-5)).toBe("0s");
		expect(formatRemaining(45_000)).toBe("45s");
		expect(formatRemaining(5 * 60_000 + 10_000)).toBe("5m");
		expect(formatRemaining(2 * 3_600_000 + 15 * 60_000)).toBe("2h 15m");
		expect(formatRemaining(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
	});

	it("names buyers by handle, else display name; never by email", () => {
		const buyer: BuyerSummary = { id: "u", handle: "ash", displayName: "Ash K", record };
		expect(buyerLabel(buyer)).toBe("@ash");
		expect(buyerLabel({ ...buyer, handle: null })).toBe("Ash K");
		expect(buyerLabel(undefined)).toBe("A buyer");
	});

	it("[SM-4.3-seller-rescind] offers every reason code with whose record it affects", () => {
		expect(RESCIND_REASON_OPTIONS.map((o) => o.code)).toEqual(RESCIND_REASON_CODES);
		expect(RESCIND_REASON_OPTIONS.find((o) => o.code === "seller_listing_error")?.note).toBe(
			"counts on your record",
		);
		expect(RESCIND_REASON_OPTIONS.find((o) => o.code === "suspected_fraud")?.note).toBe(
			"held for admin review",
		);
	});
});
