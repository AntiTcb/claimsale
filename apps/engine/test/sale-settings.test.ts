import { DAY, DEFAULT_DECISION_WINDOW, HOUR } from "@claimsale/core";
import { describe, expect, it } from "vitest";
import { lockOrder, type LockKey } from "../src/sale/locks.ts";
import { readSaleSettings, readShippingMenu } from "../src/sale/settings.ts";

describe("sale settings from the terms JSON", () => {
	it("falls back to the defaults for missing or malformed terms", () => {
		for (const terms of [null, "not json", "[]", "{}", {}]) {
			expect(readSaleSettings(terms, null, "free")).toEqual({
				reviewEveryClaim: false,
				allowBackupOffers: true,
				decisionWindow: DEFAULT_DECISION_WINDOW,
				paymentDeadline: 48 * HOUR,
				autoSendAtClose: false,
				autoRescindOverdue: false,
				buyerRequirements: { emailVerified: true, minAccountAge: 0 },
				shippingMenu: [],
				offerVisibility: "blind",
			});
		}
	});

	it("reads the web form's terms and the Pro-only settings [SM-4.2-window-length] [SM-6-payment-deadline]", () => {
		const terms = JSON.stringify({
			reviewEveryClaim: true,
			allowBackupOffers: false,
			paymentDeadlineHours: 24,
			decisionWindowHours: 6,
			autoSendAtClose: true,
			autoRescindOverdue: true,
			requireVerifiedEmail: false,
			minAccountAgeDays: 30,
			offerVisibility: "visible",
		});
		expect(readSaleSettings(terms, null, "pro")).toMatchObject({
			reviewEveryClaim: true,
			allowBackupOffers: false,
			decisionWindow: 6 * HOUR,
			paymentDeadline: 24 * HOUR,
			autoSendAtClose: true,
			autoRescindOverdue: true,
			// D20 always applies: a stored requireVerifiedEmail (an older terms form) is ignored (D68).
			buyerRequirements: { emailVerified: true, minAccountAge: 30 * DAY },
			offerVisibility: "visible",
		});
		// A free seller always gets 24h to decide and 48h for payment.
		expect(readSaleSettings(terms, null, "free")).toMatchObject({
			decisionWindow: DEFAULT_DECISION_WINDOW,
			paymentDeadline: 48 * HOUR,
		});
	});

	it("caps a Pro window at 7 days unless the seller has an approved cap [SM-4.2-window-length]", () => {
		const terms = JSON.stringify({ decisionWindowHours: 400 });
		expect(readSaleSettings(terms, null, "pro").decisionWindow).toBe(7 * DAY);
		expect(readSaleSettings(terms, null, "pro", 336).decisionWindow).toBe(336 * HOUR);
		expect(readSaleSettings(terms, null, "pro", 500).decisionWindow).toBe(400 * HOUR);
	});

	it("always requires a verified email (D20) [SM-4.1-buyer-requirements]", () => {
		expect(
			readSaleSettings({ requireVerifiedEmail: false }, null, "pro").buyerRequirements.emailVerified,
		).toBe(true);
	});

	it("keeps only well-formed shipping options", () => {
		expect(
			readShippingMenu(
				JSON.stringify([
					{ id: "pwe", label: "Envelope", priceCents: 100, tracked: false },
					{ id: "bad", label: "Negative", priceCents: -5 },
					{ id: "frac", label: "Fraction", priceCents: 1.5 },
					"nonsense",
					{ id: "ground", label: "Ground", priceCents: 550, tracked: true },
				]),
			),
		).toEqual([
			{ id: "pwe", label: "Envelope", priceCents: 100, tracked: false },
			{ id: "ground", label: "Ground", priceCents: 550, tracked: true },
		]);
		expect(readShippingMenu({ options: [{ id: "a", label: "A", priceCents: 0 }] })).toEqual([
			{ id: "a", label: "A", priceCents: 0, tracked: false },
		]);
	});
});

describe("lock order", () => {
	it("sorts the sale first, items by ID, invoices last [SM-9-serialized-writes]", () => {
		const keys: LockKey[] = ["invoices", "item:b", "sale", "item:a"];
		expect(keys.toSorted(lockOrder)).toEqual(["sale", "item:a", "item:b", "invoices"]);
	});
});
