import { isRedirect } from "@sveltejs/kit";
import { describe, expect, it } from "vitest";
import { entitlements } from "./entitlements.ts";
import { requireSeller, sellerReadiness, type SellerCandidate } from "./seller.ts";

const ready: SellerCandidate = {
	id: "u1",
	emailVerified: true,
	ageAttested: "18+",
	phoneVerifiedAt: new Date("2026-11-14T00:00:00Z"),
};

async function redirectOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (isRedirect(error)) return `${error.status} ${error.location}`;
		throw error;
	}
	return "no redirect";
}

const event = (user: SellerCandidate | null) => ({
	locals: { user },
	url: new URL("http://x/sell/new?step=1"),
});

describe("entitlements(user)", () => {
	it("is Free until a plan says otherwise", async () => {
		expect((await entitlements({ id: "u1" })).tier).toBe("free");
		expect((await entitlements({ id: "u1", tier: "pro" })).tier).toBe("pro");
	});
});

describe("seller gate (D55)", () => {
	it("[AUTH-seller-requirements] lists what's missing, and Pro skips the phone", async () => {
		expect((await sellerReadiness(ready)).blockers).toEqual([]);
		expect(
			(
				await sellerReadiness({
					id: "u2",
					emailVerified: false,
					ageAttested: "13+",
					phoneVerifiedAt: null,
				})
			).blockers,
		).toEqual(["age", "email", "phone"]);
		expect((await sellerReadiness({ ...ready, ageAttested: "weird" })).blockers).toEqual(["age"]);
		const pro = await sellerReadiness({ ...ready, phoneVerifiedAt: undefined, tier: "pro" });
		expect(pro.blockers).toEqual([]);
		expect(pro.entitlements.tier).toBe("pro");
	});

	it("[AUTH-seller-requirements] requireSeller sends the signed-out to sign in and the unready to the checklist", async () => {
		expect(await redirectOf(requireSeller(event(null)))).toBe("303 /login?next=%2Fsell%2Fnew%3Fstep%3D1");
		expect(await redirectOf(requireSeller(event({ ...ready, phoneVerifiedAt: null })))).toBe(
			"303 /sell/requirements?next=%2Fsell%2Fnew%3Fstep%3D1",
		);
		const ok = await requireSeller(event(ready));
		expect(ok.user).toBe(ready);
		expect(ok.entitlements.tier).toBe("free");
	});
});
