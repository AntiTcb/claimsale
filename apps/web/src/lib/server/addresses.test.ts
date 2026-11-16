import { createDb, type Db } from "@claimsale/db";
import { subscriptions } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, grantSellerPro } from "../../../test/fixtures.ts";
import {
	addAddress,
	deleteAddress,
	listAddresses,
	MAX_ADDRESSES,
	setDefaultAddress,
	validateAddress,
} from "./addresses.ts";
import { entitlements, FREE } from "./entitlements.ts";

let db: Db;
const home = {
	name: "Ash Ketchum",
	line1: "1 Pallet Rd",
	line2: "",
	city: "Pallet Town",
	region: "ca",
	postalCode: "94107",
};

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "u1");
	await addUser(db, "u2");
});

function valid(over: Partial<typeof home> = {}) {
	const result = validateAddress({ ...home, ...over });
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.value;
}

describe("address book", () => {
	it("validates and normalizes a US address", () => {
		expect(valid()).toEqual({ ...home, line2: null, region: "CA", country: "US" });
		const bad = validateAddress({
			name: "",
			line1: "",
			line2: "x".repeat(101),
			city: "",
			region: "ZZ",
			postalCode: "123",
		});
		expect(bad.ok).toBe(false);
		expect(!bad.ok && Object.keys(bad.errors).toSorted()).toEqual(
			["city", "line1", "line2", "name", "postalCode", "region"].toSorted(),
		);
		expect(validateAddress({ ...home, postalCode: "94107-1234" }).ok).toBe(true);
	});

	it("makes the first address the default and moves the default on request", async () => {
		const first = await addAddress(db, "u1", valid(), false, 1);
		const second = await addAddress(db, "u1", valid({ name: "Misty" }), false, 2);
		if (!first.ok || !second.ok) throw new Error("setup");
		expect(first.value.isDefault).toBe(true);
		expect(second.value.isDefault).toBe(false);
		expect(await setDefaultAddress(db, "u1", second.value.id, 3)).toEqual({ ok: true, value: true });
		expect((await listAddresses(db, "u1")).map((a) => [a.name, a.isDefault])).toEqual([
			["Misty", true],
			["Ash Ketchum", false],
		]);
		const third = await addAddress(db, "u1", valid({ name: "Brock" }), true, 4);
		expect(third.ok && third.value.isDefault).toBe(true);
		expect((await listAddresses(db, "u1")).filter((a) => a.isDefault)).toHaveLength(1);
		expect(await listAddresses(db, "u2")).toEqual([]);
		expect(await setDefaultAddress(db, "u2", second.value.id, 5)).toMatchObject({
			error: { code: "not_found" },
		});
	});

	it("soft-deletes, handing the default to the next address, and caps the book", async () => {
		const a = await addAddress(db, "u1", valid(), false, 1);
		await addAddress(db, "u1", valid({ name: "Misty" }), false, 2);
		if (!a.ok) throw new Error("setup");
		expect(await deleteAddress(db, "u2", a.value.id, 3)).toMatchObject({ error: { code: "not_found" } });
		expect(await deleteAddress(db, "u1", a.value.id, 3)).toEqual({ ok: true, value: true });
		expect((await listAddresses(db, "u1")).map((x) => [x.name, x.isDefault])).toEqual([["Misty", true]]);
		for (let i = 1; i < MAX_ADDRESSES; i++)
			await addAddress(db, "u1", valid({ name: `N${i}` }), false, 10 + i);
		expect(await addAddress(db, "u1", valid(), false, 99)).toMatchObject({ error: { code: "too_many" } });
	});
});

describe("entitlements", () => {
	it("are free without a subscription, and Pro on the side the plan covers while it is active", async () => {
		expect(await entitlements(db, "u1", 100)).toEqual(FREE);
		await grantSellerPro(db, "u1");
		expect(await entitlements(db, "u1", 100)).toEqual({ seller: "pro", buyer: "free" });
		await db.insert(subscriptions).values({
			userId: "u2",
			planId: "bundle",
			status: "active",
			currentPeriodEnd: 1000,
			createdAt: 0,
			updatedAt: 0,
		});
		expect(await entitlements(db, "u2", 999)).toEqual({ seller: "pro", buyer: "pro" });
		expect(await entitlements(db, "u2", 1000)).toEqual(FREE);
		await db.insert(subscriptions).values({
			userId: "u2",
			planId: "buyer_pro",
			status: "canceled",
			currentPeriodEnd: null,
			createdAt: 0,
			updatedAt: 0,
		});
		expect(await entitlements(db, "u2", 1000)).toEqual(FREE);
	});
});
