import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DAY } from "./common.ts";
import {
	buyerBlockers,
	DEFAULT_BUYER_REQUIREMENTS,
	sellerBlockers,
	validateAge,
	validateDisplayName,
	validateFacebookUrl,
	validateHandle,
} from "./identity.ts";

const value = <T>(r: { ok: boolean; value?: T; message?: string }) => (r.ok ? r.value : `ERR: ${r.message}`);

describe("handles", () => {
	it("normalizes case, a leading @ and spaces", () => {
		expect(value(validateHandle("  @Card_Shark9 "))).toBe("card_shark9");
	});

	it.each([
		["ab", "Handles are 3–20 characters"],
		["a".repeat(21), "Handles are 3–20 characters"],
		["9lives", "Use letters, numbers and underscores, starting with a letter"],
		["has space", "Use letters, numbers and underscores, starting with a letter"],
		["dash-ed", "Use letters, numbers and underscores, starting with a letter"],
		["Admin", "That handle is reserved"],
		[42, "Choose a handle"],
	])("rejects %j", (raw, message) => {
		expect(value(validateHandle(raw))).toBe(`ERR: ${message}`);
	});
});

describe("display names", () => {
	it("trims and collapses spaces", () => {
		expect(value(validateDisplayName("  Ash   Ketchum "))).toBe("Ash Ketchum");
	});

	it("rejects empty, too long, control characters and non-strings", () => {
		expect(value(validateDisplayName("   "))).toBe("ERR: Enter a display name");
		expect(value(validateDisplayName("x".repeat(51)))).toBe("ERR: Display names are at most 50 characters");
		expect(value(validateDisplayName("bad\u0000name"))).toBe("ERR: Remove the special characters");
		expect(value(validateDisplayName(undefined))).toBe("ERR: Enter a display name");
	});
});

describe("Facebook profile links", () => {
	it.each([
		["facebook.com/jane.doe", "https://www.facebook.com/jane.doe"],
		["https://m.facebook.com/jane.doe/", "https://www.facebook.com/jane.doe"],
		["http://fb.com/jane.doe?ref=x", "https://www.facebook.com/jane.doe"],
		[
			"https://www.facebook.com/profile.php?id=1000123&sk=about",
			"https://www.facebook.com/profile.php?id=1000123",
		],
	])("normalizes %s", (raw, expected) => {
		expect(value(validateFacebookUrl(raw))).toBe(expected);
	});

	it("treats blank as none", () => {
		expect(value(validateFacebookUrl(""))).toBeNull();
		expect(value(validateFacebookUrl(undefined))).toBeNull();
	});

	it.each([
		["https://evil.example/facebook.com/jane", "ERR: Enter a facebook.com profile link"],
		["https://facebook.com.evil.example/jane", "ERR: Enter a facebook.com profile link"],
		["https://www.facebook.com/", "ERR: Enter the link to your profile, not the home page"],
		["https://www.facebook.com/profile.php?id=abc", "ERR: Enter the link to your profile"],
		["https://facebook.com@evil.example/jane", "ERR: Enter a facebook.com profile link"],
		["https://www.facebook.com/<script>", "ERR: Enter the link to your profile"],
		[7, "ERR: Enter a Facebook profile link"],
	])("rejects %j", (raw, expected) => {
		expect(value(validateFacebookUrl(raw))).toBe(expected);
	});
});

describe("age attestation (D38)", () => {
	it("records 18+ or 13+ with a parent's permission, and refuses under 13", () => {
		expect(value(validateAge("18+", undefined))).toBe("18+");
		expect(value(validateAge("13-17", "on"))).toBe("13+");
		expect(value(validateAge("13-17", true))).toBe("13+");
		expect(value(validateAge("13-17", undefined))).toBe(
			"ERR: Confirm that a parent or guardian said it's OK",
		);
		expect(value(validateAge("under-13", "on"))).toBe("ERR: You need to be at least 13 to use ClaimSale");
		expect(value(validateAge(undefined, undefined))).toBe("ERR: Tell us your age range");
	});
});

describe("buyer requirements (D20, D29)", () => {
	const now = 100 * DAY;
	const buyer = { tier: "free" as const, blocked: false, emailVerified: true, accountCreatedAt: now - DAY };
	const strict = { emailVerified: true, minAccountAge: 30 * DAY };

	it("[SM-4.1-buyer-requirements] lists what stops a buyer, with Pro bypassing all but a block", () => {
		expect(buyerBlockers(buyer, DEFAULT_BUYER_REQUIREMENTS, now)).toEqual([]);
		expect(buyerBlockers({ ...buyer, emailVerified: false }, DEFAULT_BUYER_REQUIREMENTS, now)).toEqual([
			"email",
		]);
		expect(buyerBlockers({ ...buyer, emailVerified: false }, strict, now)).toEqual(["email", "account_age"]);
		expect(buyerBlockers({ ...buyer, accountCreatedAt: now - 30 * DAY }, strict, now)).toEqual([]);
		expect(buyerBlockers({ ...buyer, tier: "pro", emailVerified: false }, strict, now)).toEqual([]);
		expect(buyerBlockers({ ...buyer, tier: "pro", blocked: true }, strict, now)).toEqual(["blocked"]);
		expect(buyerBlockers({ ...buyer, emailVerified: false, blocked: true }, strict, now)).toEqual([
			"blocked",
		]);
		expect(
			buyerBlockers({ ...buyer, emailVerified: false }, { emailVerified: false, minAccountAge: 0 }, now),
		).toEqual([]);
	});

	it("[SM-4.1-buyer-requirements] a blocked buyer is never eligible, and an eligible free buyer stays eligible as Pro", () => {
		fc.assert(
			fc.property(
				fc.record({
					tier: fc.constantFrom("free" as const, "pro" as const),
					blocked: fc.boolean(),
					emailVerified: fc.boolean(),
					accountCreatedAt: fc.integer({ min: 0, max: now }),
				}),
				fc.record({ emailVerified: fc.boolean(), minAccountAge: fc.integer({ min: 0, max: 60 * DAY }) }),
				(standing, requirements) => {
					const blockers = buyerBlockers(standing, requirements, now);
					const asPro = buyerBlockers({ ...standing, tier: "pro" }, requirements, now);
					// Blocked ⇔ the only blocker is the block; Pro never adds a blocker.
					expect(blockers.includes("blocked")).toBe(standing.blocked);
					expect(standing.blocked ? blockers : ["blocked"]).toEqual(["blocked"]);
					expect(asPro.length).toBeLessThanOrEqual(blockers.length);
					expect(asPro).toEqual(standing.blocked ? ["blocked"] : []);
				},
			),
		);
	});
});

describe("seller requirements (D55, D70)", () => {
	it("[AUTH-seller-requirements] needs 18+ and a verified email, and nothing else", () => {
		const ready = { ageAttested: "18+" as const, emailVerified: true };
		expect(sellerBlockers(ready)).toEqual([]);
		expect(sellerBlockers({ ageAttested: "13+", emailVerified: false })).toEqual(["age", "email"]);
		expect(sellerBlockers({ ...ready, ageAttested: null })).toEqual(["age"]);
		expect(sellerBlockers({ ...ready, emailVerified: false })).toEqual(["email"]);
	});
});
