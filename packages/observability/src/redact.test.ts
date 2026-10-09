import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone, redact } from "./redact.ts";

describe("redact", () => {
	it("masks emails and phones inside free text", () => {
		expect(redact("contact jane.doe@example.com or +1 (555) 123-4567")).toBe(
			"contact ***@example.com or ***67",
		);
	});

	it("removes secrets by key, whatever the value type", () => {
		expect(redact({ password: "hunter2", apiKey: "abc", sessionToken: 42, ok: 1 })).toEqual({
			password: "[redacted]",
			apiKey: "[redacted]",
			sessionToken: "[redacted]",
			ok: 1,
		});
	});

	it("replaces message bodies with their length", () => {
		expect(redact({ body: "pay me F&F instead" })).toEqual({ body: "[redacted 18 chars]" });
	});

	it("masks by key even when the value doesn't look like an email or phone", () => {
		expect(redact({ email: "not-an-email" })).toEqual({ email: "not-an-email" });
		expect(redact({ phone_e164: "+15551234567" })).toEqual({ phone_e164: "***67" });
	});

	it("walks nested objects and arrays, and serializes dates and errors", () => {
		const date = new Date("2026-10-09T00:00:00Z");
		expect(redact({ users: [{ email: "a@b.co" }], at: date, err: new Error("bad a@b.co") })).toEqual({
			users: [{ email: "***@b.co" }],
			at: "2026-10-09T00:00:00.000Z",
			err: { name: "Error", message: "bad ***@b.co" },
		});
	});

	it("truncates very deep values", () => {
		const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
		expect(JSON.stringify(redact(deep))).toContain("[truncated]");
	});

	it("never leaves a raw email in the output", () => {
		fc.assert(
			fc.property(fc.emailAddress(), fc.string(), (email, noise) => {
				const out = JSON.stringify(redact({ note: noise, info: `${noise} ${email}`, nested: [email] }));
				expect(out).not.toContain(email);
			}),
		);
	});

	it("leaves short numbers alone", () => {
		expect(maskPhone("order 12345 of 3")).toBe("order 12345 of 3");
		expect(maskEmail("no email here")).toBe("no email here");
	});
});
