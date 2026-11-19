import { describe, expect, it } from "vitest";
import { actorFor, planLimits } from "./plan-limits.ts";
import { can } from "./permissions.ts";
import { FREE_ACTIVE_SALE_CAP, FREE_ITEM_CAP } from "./plans.ts";

describe("plan limits", () => {
	it("is Free unless the tier is exactly pro", () => {
		for (const tier of [undefined, null, "", "free", "PRO", "enterprise", 1]) {
			expect(planLimits(tier)).toMatchObject({
				tier: "free",
				buyerRequirementsApply: true,
				activeSaleCap: FREE_ACTIVE_SALE_CAP,
				itemCapPerSale: FREE_ITEM_CAP,
			});
		}
		expect(planLimits("pro")).toEqual({
			tier: "pro",
			buyerRequirementsApply: false,
			activeSaleCap: null,
			itemCapPerSale: null,
		});
	});

	it("[SM-8-permissions] actors get Pro-only actions only from Pro entitlements", () => {
		const free = planLimits(undefined);
		const pro = planLimits("pro");
		expect(can(actorFor("seller", "s1", free), "set_hidden_min_offer")).toBe(false);
		expect(can(actorFor("seller", "s1", pro), "set_hidden_min_offer")).toBe(true);
		expect(can(actorFor("buyer", "b1", free), "rescind_own_win")).toBe(false);
		expect(can(actorFor("buyer", "b1", pro), "rescind_own_win")).toBe(true);
		expect(can(actorFor("buyer", "b1", pro), "award")).toBe(false);
	});
});
