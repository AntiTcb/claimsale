import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	genericShippingExport,
	itemsExport,
	ordersExport,
	ORDER_COLUMNS,
	pirateShipExport,
	type OrderSource,
} from "./export.ts";

const order = (overrides: Partial<OrderSource> = {}): OrderSource => ({
	invoiceNumber: "CS-1001",
	status: "paid",
	buyer: { id: "u1", handle: "ashk", displayName: "Ash K", email: "ash@example.com", phone: "+15555550100" },
	shippingAddress: {
		name: "Ash Ketchum",
		line1: "1 Route 1",
		line2: null,
		city: "Pallet",
		region: "KT",
		postalCode: "00001",
		country: "US",
	},
	lines: [
		{ title: "Charizard ex", sku: "CHZ-1", amountCents: 4000, refundOwed: false },
		{ title: "Pikachu", sku: null, amountCents: 500, refundOwed: true },
	],
	shippingOptionLabel: "Ground Advantage",
	shippingCents: 550,
	adjustmentCents: -100,
	paidAt: Date.UTC(2026, 10, 2),
	shippedAt: null,
	tracking: null,
	...overrides,
});

const allCells = (table: { headers: readonly string[]; rows: readonly (readonly string[])[] }) =>
	[...table.headers, ...table.rows.flat()].join("\n");

describe("orders export [IO-export-privacy]", () => {
	it("has one row per won line with handle, display name and address only [IO-export-privacy]", () => {
		const table = ordersExport([order()]);
		expect(table.headers).toEqual(ORDER_COLUMNS);
		expect(table.rows).toHaveLength(1);
		const row = Object.fromEntries(table.headers.map((h, i) => [h, table.rows[0]![i]]));
		expect(row).toMatchObject({
			invoice_number: "CS-1001",
			buyer_handle: "ashk",
			buyer_display_name: "Ash K",
			ship_name: "Ash Ketchum",
			ship_city: "Pallet",
			item: "Charizard ex",
			price: "40.00",
			shipping: "5.50",
			invoice_total: "44.50",
			paid_at: "2026-11-02T00:00:00.000Z",
		});
	});

	it("never contains an email or phone number, whatever the buyer record holds (property) [IO-export-privacy]", () => {
		const contact = fc.record({
			email: fc.emailAddress(),
			phone: fc.stringMatching(/^\+1\d{10}$/),
		});
		fc.assert(
			fc.property(
				contact,
				fc.constantFrom<OrderSource["status"]>("sent", "buyer_paid", "paid", "shipped"),
				({ email, phone }, status) => {
					const orders = [
						order({ status, buyer: { id: "u1", handle: "ashk", displayName: "Ash K", email, phone } }),
					];
					for (const table of [
						ordersExport(orders),
						pirateShipExport(orders),
						genericShippingExport(orders),
					]) {
						const text = allCells(table);
						expect(text).not.toContain(email);
						expect(text).not.toContain(phone);
						expect(table.headers.join(",")).not.toMatch(/email|phone/i);
					}
				},
			),
		);
	});

	it("leaves out cancelled invoices and orders with no won lines [IO-export-privacy]", () => {
		expect(ordersExport([order({ status: "cancelled" })]).rows).toEqual([]);
		expect(
			ordersExport([order({ lines: [{ title: "x", sku: null, amountCents: 1, refundOwed: true }] })]).rows,
		).toEqual([]);
	});

	it("leaves address cells blank before payment, and blanks missing SKU and shipping option [IO-export-privacy]", () => {
		const table = ordersExport([
			order({
				status: "sent",
				shippingAddress: null,
				shippingOptionLabel: null,
				lines: [{ title: "Pikachu", sku: null, amountCents: 500, refundOwed: false }],
			}),
		]);
		const row = Object.fromEntries(table.headers.map((h, i) => [h, table.rows[0]![i]]));
		expect(row).toMatchObject({
			ship_name: "",
			ship_line1: "",
			ship_country: "",
			sku: "",
			shipping_option: "",
		});
		expect(genericShippingExport([order({ shippingOptionLabel: null })]).rows[0]!.at(-1)).toBe("");
	});

	it("escapes buyer-controlled text that looks like a formula [IO-export-privacy]", () => {
		const table = ordersExport([order({ buyer: { id: "u", handle: "h", displayName: '=HYPERLINK("x")' } })]);
		expect(table.rows[0]![2]).toBe(`'=HYPERLINK("x")`);
	});
});

describe("items export", () => {
	const base = {
		sku: null,
		title: "Listing",
		description: "",
		priceCents: 100,
		quantity: 1,
		offers: "off" as const,
		minOfferCents: null,
		shippingOverrideCents: null,
		status: "available",
		winnerHandle: null,
		finalPriceCents: null,
	};

	it("adds attribute columns only for games it knows, and accessories without a game", () => {
		const table = itemsExport([
			{
				...base,
				id: "a",
				game: null,
				kind: "accessory",
				attributes: { accessory_type: "playmat", condition: "new" },
			},
			// A game that was removed from the registry contributes no attribute columns.
			{ ...base, id: "b", game: "retired-game", kind: "single", attributes: { name: "Old card" } },
		]);
		expect(table.headers.slice(-3)).toEqual(["accessory_type", "brand", "condition"]);
		expect(table.headers).not.toContain("name");
		expect(table.rows[1]![table.headers.indexOf("game")]).toBe("retired-game");
	});
});

describe("shipping-tool layouts [IO-export-privacy]", () => {
	it("Pirate Ship gets one row per paid, unshipped order with an address [IO-export-privacy]", () => {
		const table = pirateShipExport([
			order(),
			order({ invoiceNumber: "CS-1002", status: "shipped" }),
			order({ invoiceNumber: "CS-1003", shippingAddress: null }),
		]);
		expect(table.rows).toEqual([
			["CS-1001", "Ash Ketchum", "", "1 Route 1", "", "Pallet", "KT", "00001", "US", "Charizard ex"],
		]);
	});

	it("the generic layout carries the item count and shipping option [IO-export-privacy]", () => {
		const table = genericShippingExport([order()]);
		expect(table.rows[0]).toEqual([
			"CS-1001",
			"Ash Ketchum",
			"1 Route 1",
			"",
			"Pallet",
			"KT",
			"00001",
			"US",
			"1",
			"Charizard ex",
			"Ground Advantage",
		]);
	});
});
