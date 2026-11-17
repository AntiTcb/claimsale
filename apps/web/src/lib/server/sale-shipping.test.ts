import { SUGGESTED_SHIPPING } from "@claimsale/core";
import { createDb, eq, type Db } from "@claimsale/db";
import { sales, sellerProfiles } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { DEFAULT_TERMS } from "#lib/listing-input.ts";
import { readShippingSettings, saveShippingSettings, validateShippingSettings } from "./sale-shipping.ts";
import { createDraft, findSellerSale, updateTerms, type Seller } from "./sales.ts";

let db: Db;
const seller: Seller = { id: "seller", tier: "free" };

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	await addUser(db, "other");
});

async function draft() {
	const result = await createDraft(
		db,
		seller,
		{ title: "Sale", descriptionMd: "", visibility: "unlisted" },
		1,
	);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

const input = (over: Partial<Parameters<typeof validateShippingSettings>[0]> = {}) => ({
	options: [
		{ id: "pwe", label: "Envelope", price: "1.50", tracked: false },
		{ id: "", label: "Ground", price: "5", tracked: true },
	],
	autoSendAtClose: true,
	autoRescindOverdue: false,
	handles: { paypal_gs: " @sella ", venmo: "" },
	...over,
});

describe("shipping and payment settings", () => {
	it("suggests a menu until the seller saves one [SM-6-shipping-menu]", async () => {
		const sale = await draft();
		const settings = await readShippingSettings(db, seller.id, sale);
		expect(settings).toMatchObject({
			menu: SUGGESTED_SHIPPING,
			suggested: true,
			autoSendAtClose: false,
			autoRescindOverdue: false,
			paymentHandles: [],
		});
	});

	it("validates the menu and the handles [SM-6-shipping-menu]", () => {
		const valid = validateShippingSettings(input(), () => "new1");
		expect(valid).toEqual({
			ok: true,
			value: {
				menu: [
					{ id: "pwe", label: "Envelope", priceCents: 150, tracked: false },
					{ id: "new1", label: "Ground", priceCents: 500, tracked: true },
				],
				autoSendAtClose: true,
				autoRescindOverdue: false,
				paymentHandles: [{ kind: "paypal_gs", value: "@sella" }],
			},
		});
		const invalid = validateShippingSettings(
			input({
				options: [{ id: "", label: "", price: "x", tracked: false }],
				handles: { venmo: "v".repeat(101) },
			}),
		);
		expect(
			invalid.ok ? null : [invalid.error.menu.map((e) => e.field), Object.keys(invalid.error.handles)],
		).toEqual([["label", "price"], ["venmo"]]);
	});

	it("saves the menu, the switches the engine reads and the handles, keeping other terms [SM-6-shipping-menu]", async () => {
		const sale = await draft();
		const valid = validateShippingSettings(input(), () => "new1");
		if (!valid.ok) throw new Error("invalid");
		expect(await saveShippingSettings(db, seller.id, sale.id, valid.value, 5)).toEqual({
			ok: true,
			value: true,
		});
		const row = await findSellerSale(db, seller.id, sale.id);
		expect(row!.shipping).toEqual(valid.value.menu);
		expect(row!.terms).toMatchObject({ ...DEFAULT_TERMS, autoSendAtClose: true, autoRescindOverdue: false });
		const profile = await db.select().from(sellerProfiles).where(eq(sellerProfiles.userId, seller.id)).get();
		expect(profile!.paymentHandles).toEqual([{ kind: "paypal_gs", value: "@sella" }]);
		const read = await readShippingSettings(db, seller.id, row!);
		expect(read).toMatchObject({ suggested: false, autoSendAtClose: true, menu: valid.value.menu });
	});

	it("saving the terms form keeps the shipping page's switches (regression)", async () => {
		const sale = await draft();
		const valid = validateShippingSettings(input(), () => "new1");
		if (!valid.ok) throw new Error("invalid");
		await saveShippingSettings(db, seller.id, sale.id, valid.value, 5);
		await updateTerms(db, seller, sale.id, { ...DEFAULT_TERMS, shipsTo: "US and CA" }, 6);
		const row = await findSellerSale(db, seller.id, sale.id);
		expect(row!.terms).toMatchObject({ shipsTo: "US and CA", autoSendAtClose: true });
	});

	it("only the sale's seller can save, and not after the sale is archived", async () => {
		const sale = await draft();
		const valid = validateShippingSettings(input());
		if (!valid.ok) throw new Error("invalid");
		expect(await saveShippingSettings(db, "other", sale.id, valid.value, 5)).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		await db.update(sales).set({ status: "closed" }).where(eq(sales.id, sale.id));
		expect((await saveShippingSettings(db, seller.id, sale.id, valid.value, 5)).ok).toBe(true);
		await db.update(sales).set({ status: "archived" }).where(eq(sales.id, sale.id));
		expect(await saveShippingSettings(db, seller.id, sale.id, valid.value, 5)).toMatchObject({
			ok: false,
			error: { code: "invalid_status" },
		});
	});
});
