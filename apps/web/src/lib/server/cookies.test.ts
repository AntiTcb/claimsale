import { describe, expect, it, vi } from "vitest";
import { forwardCookies, parseSetCookie } from "./cookies.ts";
import { isOnboardingExempt, needsOnboarding, safeRedirect } from "./onboarding.ts";

describe("parseSetCookie", () => {
	it("reads Better Auth's session cookie with every attribute", () => {
		const cookie = parseSetCookie(
			"cs.session_token=abc.def%2Bg=; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=claimsale.net",
		);
		expect(cookie).toEqual({
			name: "cs.session_token",
			value: "abc.def%2Bg=",
			options: {
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "lax",
				maxAge: 604800,
				domain: "claimsale.net",
			},
		});
	});

	it("reads deletions and expiry dates, and ignores junk attributes", () => {
		expect(
			parseSetCookie("a=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Weird; Max-Age=x"),
		).toEqual({
			name: "a",
			value: "",
			options: { path: "/", httpOnly: false, secure: false, maxAge: 0, expires: new Date(0) },
		});
		expect(parseSetCookie("b=1; Path=; Expires=not a date; Domain=")?.options).toEqual({
			path: "/",
			httpOnly: false,
			secure: false,
		});
		expect(parseSetCookie("=novalue")).toBeUndefined();
		expect(parseSetCookie("")).toBeUndefined();
	});
});

describe("forwardCookies", () => {
	it("sets every cookie with its value unencoded", () => {
		const headers = new Headers();
		headers.append("set-cookie", "one=a%20b; Path=/; HttpOnly");
		headers.append("set-cookie", "two=2; Path=/x; SameSite=Strict");
		headers.append("set-cookie", "garbage");
		const set = vi.fn<(name: string, value: string, options: unknown) => void>();
		forwardCookies(headers, { set });
		expect(set).toHaveBeenCalledTimes(2);
		const [name, value, options] = set.mock.calls[0]!;
		expect([name, value]).toEqual(["one", "a%20b"]);
		expect(options).toMatchObject({ path: "/", httpOnly: true });
		expect((options as { encode: (v: string) => string }).encode("a%20b")).toBe("a%20b");
		expect(set.mock.calls[1]?.[2]).toMatchObject({ path: "/x", sameSite: "strict" });
	});
});

describe("onboarding gate", () => {
	it("applies to signed-in accounts without a handle or an age attestation", () => {
		expect(needsOnboarding(null)).toBe(false);
		expect(needsOnboarding({ handle: "ash", ageAttested: "18+" })).toBe(false);
		expect(needsOnboarding({ handle: "ash", ageAttested: "13+" })).toBe(false);
		expect(needsOnboarding({ handle: null, ageAttested: "18+" })).toBe(true);
		expect(needsOnboarding({ handle: "ash", ageAttested: null })).toBe(true);
		expect(needsOnboarding({ handle: "ash", ageAttested: "21+" })).toBe(true);
	});

	it("leaves the home page, profiles, onboarding and APIs reachable", () => {
		for (const path of ["/", "/onboarding", "/u/ash", "/api/auth/sign-out", "/logout", "/_app/x.js"]) {
			expect(isOnboardingExempt(path)).toBe(true);
		}
		for (const path of ["/me/settings", "/sell", "/s/some-sale"])
			expect(isOnboardingExempt(path)).toBe(false);
	});

	it("only redirects to same-site paths", () => {
		expect(safeRedirect("/me/settings?tab=1")).toBe("/me/settings?tab=1");
		for (const target of ["https://evil.example", "//evil.example", "/\\evil.example", "me", null, 7]) {
			expect(safeRedirect(target)).toBe("/");
		}
		expect(safeRedirect(undefined, "/onboarding")).toBe("/onboarding");
	});
});
