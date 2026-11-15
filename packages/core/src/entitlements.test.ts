import { describe, expect, it } from "vitest";
import { actorFor, entitlementsFor } from "./entitlements.ts";
import { can } from "./permissions.ts";
import { FREE_ACTIVE_SALE_CAP, FREE_ITEM_CAP } from "./plans.ts";

describe("entitlements", () => {
	it("is Free unless the tier is exactly pro", () => {
		for (const tier of [undefined, null, "", "free", "PRO", "enterprise", 1]) {
			expect(entitlementsFor(tier)).toMatchObject({
				tier: "free",
				sellerPhoneRequired: true,
				buyerRequirementsApply: true,
				activeSaleCap: FREE_ACTIVE_SALE_CAP,
				itemCapPerSale: FREE_ITEM_CAP,
			});
		}
		expect(entitlementsFor("pro")).toEqual({
			tier: "pro",
			sellerPhoneRequired: false,
			buyerRequirementsApply: false,
			activeSaleCap: null,
			itemCapPerSale: null,
		});
	});

	it("[SM-8-permissions] actors get Pro-only actions only from Pro entitlements", () => {
		const free = entitlementsFor(undefined);
		const pro = entitlementsFor("pro");
		expect(can(actorFor("seller", "s1", free), "set_hidden_min_offer")).toBe(false);
		expect(can(actorFor("seller", "s1", pro), "set_hidden_min_offer")).toBe(true);
		expect(can(actorFor("buyer", "b1", free), "rescind_own_win")).toBe(false);
		expect(can(actorFor("buyer", "b1", pro), "rescind_own_win")).toBe(true);
		expect(can(actorFor("buyer", "b1", pro), "award")).toBe(false);
	});
});
