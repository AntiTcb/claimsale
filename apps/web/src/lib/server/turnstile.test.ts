import { describe, expect, it } from "vitest";
import { TEST_SECRET_KEY, TEST_SITE_KEY, turnstileConfig } from "./turnstile.ts";

describe("turnstileConfig", () => {
	it("[AUTH-signup-captcha] pairs the test site key with the test secret, and a real key only with its secret", () => {
		expect(turnstileConfig(TEST_SITE_KEY, undefined)).toEqual({
			siteKey: TEST_SITE_KEY,
			secretKey: TEST_SECRET_KEY,
		});
		expect(turnstileConfig("0x4AAAreal", "0x4AAAsecret")).toEqual({
			siteKey: "0x4AAAreal",
			secretKey: "0x4AAAsecret",
		});
		// A real site key never falls back to the always-passing secret: sign-up turns off instead.
		expect(turnstileConfig("0x4AAAreal", undefined)).toBeUndefined();
		expect(turnstileConfig("0x4AAAreal", "  ")).toBeUndefined();
		expect(turnstileConfig("", "0x4AAAsecret")).toBeUndefined();
		expect(turnstileConfig(undefined, undefined)).toBeUndefined();
	});
});
