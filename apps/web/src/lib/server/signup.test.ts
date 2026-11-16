import { createDb, type Db } from "@claimsale/db";
import { users } from "@claimsale/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { createAuth } from "./auth.ts";
import type { Mailer } from "./mailer.ts";
import { signUpWithCaptcha } from "./signup.ts";

const ORIGIN = "http://localhost:8787";
const SITEVERIFY = "https://siteverify.test/turnstile";
const input = { name: "Ash", email: "ash@example.test", password: "a-long-password", callbackURL: "/" };

let db: Db;
type Siteverify = (body: unknown) => Record<string, unknown>;
let siteverify: ReturnType<typeof vi.fn<Siteverify>>;
const mailer: Mailer = { mode: "capture", send: async () => undefined };
const urlOf = (target: RequestInfo | URL): string =>
	typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
const passes: Siteverify = (body) => ({
	success: typeof body === "object" && body !== null && Reflect.get(body, "response") === "good-token",
});

const formRequest = () =>
	new Request(`${ORIGIN}/signup`, {
		method: "POST",
		headers: { "cf-connecting-ip": "203.0.113.7", "user-agent": "test" },
	});

beforeEach(() => {
	db = createDb(testD1());
	siteverify = vi.fn<Siteverify>(passes);
	const realFetch = globalThis.fetch;
	vi.stubGlobal(
		"fetch",
		vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (url, init) => {
			if (urlOf(url) !== SITEVERIFY) return realFetch(url, init);
			const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
			return Response.json(siteverify(body));
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

const authWithCaptcha = () =>
	createAuth({
		db,
		mailer,
		origin: ORIGIN,
		secret: "s".repeat(32),
		captcha: { secretKey: "test-secret", siteVerifyUrl: SITEVERIFY },
	});

const userCount = async () => (await db.select({ id: users.id }).from(users).all()).length;

describe("sign-up with Turnstile", () => {
	it("[AUTH-signup-captcha] creates the account and session only with a passing token", async () => {
		const result = await signUpWithCaptcha(authWithCaptcha(), formRequest(), ORIGIN, input, "good-token");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.userId).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.headers.getSetCookie().join(";")).toContain("cs.session_token=");
		expect(siteverify).toHaveBeenCalledWith({
			secret: "test-secret",
			response: "good-token",
			remoteip: "203.0.113.7",
		});
		expect(await userCount()).toBe(1);
	});

	it("[AUTH-signup-captcha] refuses a missing or failing token, without creating an account", async () => {
		const auth = authWithCaptcha();
		expect(await signUpWithCaptcha(auth, formRequest(), ORIGIN, input, "")).toEqual({
			ok: false,
			message: "Complete the check that you're a person, then try again.",
		});
		expect(await signUpWithCaptcha(auth, formRequest(), ORIGIN, input, "bad-token")).toEqual({
			ok: false,
			message: "We couldn't confirm you're a person. Try the check again.",
		});
		expect(await userCount()).toBe(0);
	});

	it("[AUTH-signup-captcha] guards the API endpoint too, not just the form", async () => {
		const response = await authWithCaptcha().handler(
			new Request(`${ORIGIN}/api/auth/sign-up/email`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify(input),
			}),
		);
		expect(response.status).toBe(400);
		expect(await userCount()).toBe(0);
	});

	it("[AUTH-signup-captcha] turns email sign-up off when Turnstile isn't configured", async () => {
		const auth = createAuth({ db, mailer, origin: ORIGIN, secret: "s".repeat(32) });
		expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
		expect(await signUpWithCaptcha(auth, formRequest(), ORIGIN, input, "good-token")).toEqual({
			ok: false,
			message: "Sign-up is unavailable right now. Try again later.",
		});
		expect(await userCount()).toBe(0);
	});

	it("applies Better Auth's per-address sign-up limit to the form", async () => {
		const auth = authWithCaptcha();
		const results = [];
		for (let i = 0; i < 6; i++) {
			// oxlint-disable-next-line no-await-in-loop -- attempts are sequential on purpose
			results.push(
				await signUpWithCaptcha(
					auth,
					formRequest(),
					ORIGIN,
					{ ...input, email: `user${i}@example.test` },
					"good-token",
				),
			);
		}
		expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
		expect(results[5]).toEqual({ ok: false, message: "Too many attempts. Wait a minute and try again." });
	});

	it("reports an existing account in our words", async () => {
		const auth = authWithCaptcha();
		await signUpWithCaptcha(auth, formRequest(), ORIGIN, input, "good-token");
		const again = await signUpWithCaptcha(auth, formRequest(), ORIGIN, input, "good-token");
		expect(again.ok).toBe(false);
		expect(again).toMatchObject({ message: expect.stringMatching(/already exists|went wrong/) });
	});
});
