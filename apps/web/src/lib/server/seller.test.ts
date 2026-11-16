import { isRedirect } from "@sveltejs/kit";
import { describe, expect, it } from "vitest";
import { assertSellerReady, sellerReadiness, type SellerCandidate } from "./seller.ts";

const ready: SellerCandidate = {
	emailVerified: true,
	ageAttested: "18+",
	phoneVerifiedAt: new Date("2026-11-14T00:00:00Z"),
};

describe("sellerReadiness (D55)", () => {
	it("[AUTH-seller-requirements] lists what's missing, and Pro skips the phone", () => {
		expect(sellerReadiness(ready, "free")).toEqual([]);
		expect(
			sellerReadiness({ emailVerified: false, ageAttested: "13+", phoneVerifiedAt: null }, "free"),
		).toEqual(["age", "email", "phone"]);
		expect(sellerReadiness({ ...ready, ageAttested: "weird" }, "free")).toEqual(["age"]);
		expect(sellerReadiness({ ...ready, phoneVerifiedAt: undefined }, "pro")).toEqual([]);
		expect(sellerReadiness({ ...ready, phoneVerifiedAt: undefined }, "free")).toEqual(["phone"]);
	});

	it("[AUTH-seller-requirements] assertSellerReady redirects to the checklist with where to go next", () => {
		expect(() => assertSellerReady(new URL("http://x/sell"), ready, "free")).not.toThrow();
		let location = "";
		try {
			assertSellerReady(new URL("http://x/sell/new?step=1"), { ...ready, phoneVerifiedAt: null }, "free");
		} catch (error) {
			if (isRedirect(error)) location = `${error.status} ${error.location}`;
		}
		expect(location).toBe("303 /sell/requirements?next=%2Fsell%2Fnew%3Fstep%3D1");
	});
});
