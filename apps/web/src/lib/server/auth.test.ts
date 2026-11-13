import { createDb } from "@claimsale/db";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import { authSecret, createAuth } from "./auth.ts";
import { magicLinkEmail, passwordResetEmail, verificationEmail } from "./emails.ts";
import { authErrorMessage, field, fieldError, formError, isApiError } from "./forms.ts";
import type { EmailBinding, Mailer } from "./mailer.ts";

// Construction never queries the database, so an empty binding is enough here; the
// flows themselves run end to end in e2e/auth.spec.ts.
const db = createDb({} as D1Database);
const mailer: Mailer = { mode: "capture", send: vi.fn<Mailer["send"]>(async () => undefined) };

describe("createAuth", () => {
	it("keeps profile fields out of request bodies and limits sign-in attempts", () => {
		const auth = createAuth({ db, mailer, origin: "https://staging.claimsale.net", secret: "s".repeat(32) });
		const { options } = auth;
		for (const profileField of Object.values(options.user?.additionalFields ?? {})) {
			expect(profileField).toMatchObject({ required: false, input: false });
		}
		expect(Object.keys(options.user?.additionalFields ?? {})).toEqual([
			"handle",
			"ageAttested",
			"ageAttestedAt",
			"fbProfileUrl",
			"country",
			"phoneE164",
			"phoneVerifiedAt",
		]);
		expect(options.rateLimit).toMatchObject({ enabled: true, storage: "database" });
		expect(options.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ window: 60, max: 5 });
		expect(options.emailAndPassword).toMatchObject({
			enabled: true,
			minPasswordLength: 10,
			requireEmailVerification: false,
		});
		expect(options.advanced).toMatchObject({ useSecureCookies: true, cookiePrefix: "cs" });
		expect(options.trustedOrigins).toEqual(["https://staging.claimsale.net"]);
		expect(options.socialProviders).toEqual({});
	});

	it("turns on Discord only with credentials, and plain-HTTP cookies only for http origins", () => {
		const auth = createAuth({
			db,
			mailer,
			origin: "http://localhost:8787",
			secret: "s".repeat(32),
			discord: { clientId: "id", clientSecret: "secret" },
		});
		expect(auth.options.socialProviders).toEqual({ discord: { clientId: "id", clientSecret: "secret" } });
		expect(auth.options.advanced?.useSecureCookies).toBe(false);
	});

	it("sends each auth email through the mailer", async () => {
		const send = vi.fn<Mailer["send"]>(async () => undefined);
		const auth = createAuth({
			db,
			mailer: { mode: "capture", send },
			origin: "http://x",
			secret: "s".repeat(32),
		});
		const user = { email: "a@b.co" };
		await auth.options.emailAndPassword?.sendResetPassword?.({
			user,
			url: "http://x/r",
			token: "t",
		} as never);
		await auth.options.emailVerification?.sendVerificationEmail?.({
			user,
			url: "http://x/v",
			token: "t",
		} as never);
		expect(send.mock.calls.map(([mail]) => mail.subject)).toEqual([
			"Reset your ClaimSale password",
			"Confirm your email for ClaimSale",
		]);
	});
});

describe("authSecret", () => {
	it("uses the secret when set, a fixed one only for local and test, and refuses otherwise", () => {
		expect(authSecret("staging", "real")).toBe("real");
		expect(authSecret("local", undefined)).toMatch(/local-development/);
		expect(authSecret("test", "")).toMatch(/local-development/);
		expect(() => authSecret("preview", undefined)).toThrow("BETTER_AUTH_SECRET is not set");
		expect(() => authSecret("production", "")).toThrow("BETTER_AUTH_SECRET is not set");
	});
});

describe("auth emails", () => {
	it("put the link in both versions and escape it in HTML", () => {
		const url = 'https://x.test/verify?token=a&b="c"';
		for (const mail of [
			verificationEmail("a@b.co", url),
			magicLinkEmail("a@b.co", url),
			passwordResetEmail("a@b.co", url),
		]) {
			expect(mail.to).toBe("a@b.co");
			expect(mail.text).toContain(url);
			expect(mail.html).toContain('href="https://x.test/verify?token=a&amp;b=&quot;c&quot;"');
			expect(mail.html).not.toContain('"c"');
		}
	});
});

describe("form helpers", () => {
	it("reads string fields only", () => {
		const data = new FormData();
		data.set("name", "Ash");
		data.set("file", new Blob(["x"]));
		expect(field(data, "name")).toBe("Ash");
		expect(field(data, "file")).toBe("");
		expect(field(data, "missing")).toBe("");
		expect(formError("x")).toEqual({ form: "x" });
		expect(fieldError("handle", "taken")).toEqual({ handle: "taken" });
	});

	it("maps Better Auth errors to our words and hides the rest", () => {
		expect(authErrorMessage(new APIError("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD" }))).toBe(
			"That email and password don't match.",
		);
		expect(authErrorMessage(new APIError("TOO_MANY_REQUESTS"))).toBe(
			"Too many attempts. Wait a minute and try again.",
		);
		expect(authErrorMessage(new APIError("BAD_REQUEST", { code: "SOMETHING_INTERNAL" }))).toBe(
			"Something went wrong. Try again.",
		);
		expect(authErrorMessage(new Error("db down"))).toBe("Something went wrong. Try again.");
		expect(isApiError(new APIError("BAD_REQUEST"))).toBe(true);
		expect(isApiError(new Error("x"))).toBe(false);
	});
});

async function setup() {
	const { testD1 } = await import("../../../test/d1.ts");
	const { makeMailer } = await import("./mailer.ts");
	const { emailOutbox, users } = await import("@claimsale/db/schema");
	const sqlDb = createDb(testD1());
	const outbox = makeMailer({
		mode: "capture",
		from: "x",
		binding: { send: vi.fn<EmailBinding["send"]>() },
		db: sqlDb,
		log: () => {},
	});
	const auth = createAuth({
		db: sqlDb,
		mailer: outbox,
		origin: "http://localhost:8787",
		secret: "s".repeat(32),
	});
	return { auth, sqlDb, emailOutbox, users };
}

describe("Better Auth against the real schema", () => {
	it("signs up with a UUIDv7 ID, sends the verification email, verifies and signs in", async () => {
		const { auth, sqlDb, emailOutbox, users } = await setup();
		const signUp = await auth.api.signUpEmail({
			body: { name: "Ash", email: "ash@example.test", password: "pikachu-pikachu" },
		});
		expect(signUp.user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
		expect(signUp.user).toMatchObject({ name: "Ash", emailVerified: false, handle: null });
		const row = await sqlDb.select().from(users).get();
		expect(row).toMatchObject({ displayName: "Ash", email: "ash@example.test", emailVerified: false });
		expect(row?.createdAt).toBeInstanceOf(Date);

		const mail = await sqlDb.select().from(emailOutbox).get();
		expect(mail?.subject).toBe("Confirm your email for ClaimSale");
		const token = new URL(mail!.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
		await auth.api.verifyEmail({ query: { token } });
		expect((await sqlDb.select().from(users).get())?.emailVerified).toBe(true);

		const signIn = await auth.api.signInEmail({
			body: { email: "ash@example.test", password: "pikachu-pikachu" },
			returnHeaders: true,
		});
		expect(signIn.headers.getSetCookie().some((c) => c.startsWith("cs.session_token="))).toBe(true);
		await expect(
			auth.api.signInEmail({ body: { email: "ash@example.test", password: "wrong-password!" } }),
		).rejects.toMatchObject({
			body: { code: "INVALID_EMAIL_OR_PASSWORD" },
		});
	});

	it("rejects profile fields sent in a sign-up body", async () => {
		const { auth } = await setup();
		await expect(
			auth.api.signUpEmail({
				body: {
					name: "Eve",
					email: "eve@example.test",
					password: "long-enough-pw",
					handle: "admin",
				} as never,
			}),
		).rejects.toBeInstanceOf(APIError);
	});
});
