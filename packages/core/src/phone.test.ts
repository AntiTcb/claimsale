import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskPhoneForOwner, normalizePhone, phoneLineTypeAllowed, validatePhoneCode } from "./phone.ts";

const value = <T>(r: { ok: boolean; value?: T; message?: string }) => (r.ok ? r.value : `ERR: ${r.message}`);

describe("[AUTH-phone-e164] phone numbers normalize to E.164", () => {
	it.each([
		["+1 (202) 555-0123", "+12025550123"],
		["202.555.0123", "+12025550123"],
		["1-202-555-0123", "+12025550123"],
		["  +44 7700 900123 ", "+447700900123"],
		["0044 7700 900123", "+447700900123"],
		["+61 412 345 678", "+61412345678"],
	])("normalizes %j", (raw, expected) => {
		expect(value(normalizePhone(raw))).toBe(expected);
	});

	it.each([
		["", "Enter your mobile number"],
		[undefined, "Enter your mobile number"],
		[12025550123, "Enter your mobile number"],
		["call me", "Use digits only, with an optional + in front"],
		["202+5550123", "Use digits only, with an optional + in front"],
		["++12025550123", "Use digits only, with an optional + in front"],
		["555 0123", "Include your country code, like +44 7700 900123"],
		["+0 123 456 789", "That doesn't look like a phone number"],
		["+1234567", "That doesn't look like a phone number"],
		["+1234567890123456", "That doesn't look like a phone number"],
		["+1 102 555 0123", "That isn't a valid US or Canadian number"],
		["(202) 155-0123", "That isn't a valid US or Canadian number"],
	])("rejects %j", (raw, message) => {
		expect(value(normalizePhone(raw))).toBe(`ERR: ${message}`);
	});

	it("is idempotent: a normalized number normalizes to itself", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: fc.constantFrom("0", "1", "2", "5", "9", " ", "-", "+", "(") }),
				(raw) => {
					const once = normalizePhone(raw);
					const twice = once.ok ? normalizePhone(once.value) : once;
					expect(twice).toEqual(once);
				},
			),
		);
	});

	it("masks the number for its owner, keeping the country code and last 4 digits", () => {
		expect(maskPhoneForOwner("+12025550123")).toBe("+1 ••• 0123");
		expect(maskPhoneForOwner("+447700900123")).toBe("+44 ••• 0123");
		expect(maskPhoneForOwner("+12025550123")).not.toContain("555");
	});
});

describe("phone codes", () => {
	it("accepts 6 digits, ignoring spaces and dashes", () => {
		expect(value(validatePhoneCode("123 456"))).toBe("123456");
		expect(value(validatePhoneCode("123-456"))).toBe("123456");
	});

	it.each([["12345"], ["1234567"], ["abcdef"], [undefined]])("rejects %j", (raw) => {
		expect(value(validatePhoneCode(raw))).toBe("ERR: Enter the 6-digit code");
	});
});

describe("phone line types (TECH_STACK S10)", () => {
	it("allows mobile and unclassified numbers, and refuses VoIP and the rest", () => {
		for (const type of ["mobile", "personal", "unknown", null, undefined]) {
			expect(phoneLineTypeAllowed(type)).toBe(true);
		}
		for (const type of ["nonFixedVoip", "fixedVoip", "landline", "tollFree", "premium", "pager"]) {
			expect(phoneLineTypeAllowed(type)).toBe(false);
		}
	});
});
