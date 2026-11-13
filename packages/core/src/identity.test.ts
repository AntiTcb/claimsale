import { describe, expect, it } from "vitest";
import {
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

describe("seller requirements (D55)", () => {
	it("needs 18+, a verified email and, unless Pro, a verified phone", () => {
		const ready = { ageAttested: "18+" as const, emailVerified: true, phoneVerified: true, pro: false };
		expect(sellerBlockers(ready)).toEqual([]);
		expect(sellerBlockers({ ...ready, phoneVerified: false, pro: true })).toEqual([]);
		expect(
			sellerBlockers({ ageAttested: "13+", emailVerified: false, phoneVerified: false, pro: false }),
		).toEqual(["age", "email", "phone"]);
		expect(sellerBlockers({ ...ready, ageAttested: null })).toEqual(["age"]);
	});
});
