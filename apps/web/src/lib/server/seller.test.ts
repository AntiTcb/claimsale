import { isRedirect } from "@sveltejs/kit";
import { describe, expect, it } from "vitest";
import { assertSellerReady, sellerReadiness, type SellerCandidate } from "./seller.ts";

const ready: SellerCandidate = { emailVerified: true, ageAttested: "18+" };

describe("sellerReadiness (D55, D70)", () => {
	it("[AUTH-seller-requirements] lists what's missing: 18+ and a verified email, no phone", () => {
		expect(sellerReadiness(ready)).toEqual([]);
		expect(sellerReadiness({ emailVerified: false, ageAttested: "13+" })).toEqual(["age", "email"]);
		expect(sellerReadiness({ ...ready, ageAttested: "weird" })).toEqual(["age"]);
		expect(sellerReadiness({ ...ready, ageAttested: undefined })).toEqual(["age"]);
	});

	it("[AUTH-seller-requirements] assertSellerReady redirects to the checklist with where to go next", () => {
		expect(() => assertSellerReady(new URL("http://x/sell"), ready)).not.toThrow();
		let location = "";
		try {
			assertSellerReady(new URL("http://x/sell/new?step=1"), { ...ready, emailVerified: false });
		} catch (error) {
			if (isRedirect(error)) location = `${error.status} ${error.location}`;
		}
		expect(location).toBe("303 /sell/requirements?next=%2Fsell%2Fnew%3Fstep%3D1");
	});
});
