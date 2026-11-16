import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/** A fresh identity per test, so tests can run in parallel against one database. */
export function newIdentity(prefix = "e2e") {
	const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
	return {
		email: `${prefix}-${id}@example.test`,
		handle: `${prefix}_${id}`.slice(0, 20),
		displayName: `Tester ${id}`,
		password: `pw-${id}-long-enough`,
	};
}

export type Identity = ReturnType<typeof newIdentity>;

/** Whether captured email can be read here (local, test and isolated preview pairs only). */
export async function outboxAvailable(request: APIRequestContext): Promise<boolean> {
	const res = await request.get("/api/test/outbox?to=probe@example.test");
	return res.status() === 200;
}

/** Waits for an email whose subject contains `subject`, and returns the first link in it. */
export async function linkFromEmail(
	request: APIRequestContext,
	to: string,
	subject: string,
): Promise<string> {
	let link = "";
	await expect
		.poll(
			async () => {
				const res = await request.get(`/api/test/outbox?to=${encodeURIComponent(to)}`);
				const messages = (await res.json()) as Array<{ subject: string; text: string }>;
				const message = messages.find((m) => m.subject.includes(subject));
				link = message?.text.match(/https?:\/\/\S+/)?.[0] ?? "";
				return link;
			},
			{ message: `email "${subject}" to ${to}`, timeout: 10_000 },
		)
		.not.toBe("");
	return link;
}

/** Fills in and submits the sign-up form. */
export async function signUp(page: Page, who: Identity, age: "18+" | "13-17" = "18+"): Promise<void> {
	await page.goto("/signup");
	await page.getByLabel("Display name").fill(who.displayName);
	await page.getByLabel("Handle").fill(who.handle);
	await page.getByLabel("Email").fill(who.email);
	await page.getByLabel("Password").fill(who.password);
	await page.getByLabel(age === "18+" ? "18 or older" : "13 to 17").check();
	if (age === "13-17") await page.getByLabel(/parent or guardian/).check();
	await waitForTurnstile(page);
	await page.getByRole("button", { name: "Create account" }).click();
}

/** Waits until the Turnstile widget has put its token in the form (test keys pass at once). */
export async function waitForTurnstile(page: Page): Promise<void> {
	await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
}

/** Whether captured phone codes can be read here (local, test and isolated preview pairs only). */
export async function smsCaptureAvailable(request: APIRequestContext): Promise<boolean> {
	const res = await request.get("/api/test/sms?to=%2B12025550100");
	return res.status() === 200;
}

const digit = (min: number) => String(min + Math.floor(Math.random() * (10 - min)));

/** A random, valid North American number, so parallel tests and reruns never share one. */
export function newPhone(): { e164: string; typed: string; last4: string } {
	const area = digit(2) + digit(0) + digit(0);
	const exchange = digit(2) + digit(0) + digit(0);
	const line = digit(0) + digit(0) + digit(0) + digit(0);
	return { e164: `+1${area}${exchange}${line}`, typed: `(${area}) ${exchange}-${line}`, last4: line };
}

/**
 * Makes a signed-in 18+ account ready to sell (D55): verifies its email through the
 * captured outbox and a fresh phone through captured SMS codes.
 */
export async function verifySeller(page: Page, email: string): Promise<void> {
	const request = page.request;
	await page.goto(await linkFromEmail(request, email, "Confirm your email"));
	const phone = newPhone();
	await page.goto("/me/settings");
	await page.getByLabel("Mobile number").fill(phone.e164);
	await page.getByRole("button", { name: "Text me a code" }).click();
	await page.getByLabel("Code").fill(await codeFromSms(request, phone.e164));
	await page.getByRole("button", { name: "Verify" }).click();
	await expect(page.getByRole("status")).toHaveText("Your phone number is verified.");
}

/** The latest captured code for a number. */
export async function codeFromSms(request: APIRequestContext, e164: string): Promise<string> {
	let code = "";
	await expect
		.poll(
			async () => {
				const res = await request.get(`/api/test/sms?to=${encodeURIComponent(e164)}`);
				code = ((await res.json()) as { code?: string } | null)?.code ?? "";
				return code;
			},
			{ message: `code texted to ${e164}`, timeout: 10_000 },
		)
		.not.toBe("");
	return code;
}

export async function signOut(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}
