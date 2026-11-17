import { describe, expect, it } from "vitest";
import {
	SHIPPING_MENU_MAX,
	SUGGESTED_SHIPPING,
	validateShippingMenu,
	type ShippingOptionInput,
} from "./shipping.ts";

let next = 0;
const newId = () => `opt${next++}`;
const row = (label: string, price: string, tracked = false, id = ""): ShippingOptionInput => ({
	id,
	label,
	price,
	tracked,
});

describe("shipping menu [SM-6-shipping-menu]", () => {
	it("keeps labels, prices in cents and tracking, dropping blank rows [SM-6-shipping-menu]", () => {
		const result = validateShippingMenu(
			[row("  PWE   (untracked) ", "$1.50", false, "pwe"), row("", ""), row("Ground", "5", true)],
			newId,
		);
		expect(result).toEqual({
			ok: true,
			value: [
				{ id: "pwe", label: "PWE (untracked)", priceCents: 150, tracked: false },
				{ id: expect.stringMatching(/^opt/), label: "Ground", priceCents: 500, tracked: true },
			],
		});
	});

	it("a blank price is free shipping, e.g. local pickup [SM-6-shipping-menu]", () => {
		const result = validateShippingMenu([row("Local pickup", "")], newId);
		expect(result.ok && result.value[0]!.priceCents).toBe(0);
	});

	it("rejects missing labels, bad or too-high prices, empty and oversized menus [SM-6-shipping-menu]", () => {
		const bad = validateShippingMenu(
			[row("", "2"), row("Overnight", "250"), row("Envelope", "1.234")],
			newId,
		);
		expect(bad.ok ? [] : bad.error.map((e) => [e.row, e.field])).toEqual([
			[0, "label"],
			[1, "price"],
			[2, "price"],
		]);
		const empty = validateShippingMenu([row("", "")], newId);
		expect(empty.ok ? [] : empty.error).toEqual([
			{ row: -1, field: "menu", message: "Add at least one shipping option" },
		]);
		const many = validateShippingMenu(
			Array.from({ length: SHIPPING_MENU_MAX + 1 }, (_, i) => row(`Option ${i}`, "1")),
			newId,
		);
		expect(many.ok ? [] : many.error.map((e) => e.field)).toEqual(["menu"]);
		const long = validateShippingMenu([row("x".repeat(61), "1")], newId);
		expect(long.ok).toBe(false);
	});

	it("gives duplicate or malformed IDs a fresh one, so each option stays addressable [SM-6-shipping-menu]", () => {
		const result = validateShippingMenu(
			[row("A", "1", false, "same"), row("B", "2", false, "same"), row("C", "3", false, "Not Valid!")],
			newId,
		);
		const ids = result.ok ? result.value.map((o) => o.id) : [];
		expect(ids[0]).toBe("same");
		expect(new Set(ids).size).toBe(3);
		expect(ids[2]).toMatch(/^opt/);
	});

	it("the suggested menu is itself valid [SM-6-shipping-menu]", () => {
		const result = validateShippingMenu(
			SUGGESTED_SHIPPING.map((o) => row(o.label, (o.priceCents / 100).toFixed(2), o.tracked, o.id)),
			newId,
		);
		expect(result).toEqual({ ok: true, value: SUGGESTED_SHIPPING });
	});
});
