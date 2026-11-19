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

/**
 * Waits until SvelteKit's client router has started on the current page and the page is
 * interactive (the root layout's `data-hydrated` marker). On start it
 * calls `history.replaceState` to create the page's history entry (key
 * `sveltekit:metadata`). WebKit reports that replaceState as a navigation, so a
 * `page.goto()` issued before it is "interrupted by another navigation" to the current
 * URL, even after the load event.
 */
export async function waitForRouter(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const state: unknown = history.state;
		return typeof state === "object" && state !== null && "sveltekit:metadata" in state;
	});
	// The router can start before the page's components are interactive; under load a click
	// in between lands on the server's HTML and does nothing. The root layout marks <html>
	// once everything has mounted.
	await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
}

/**
 * After a successful sign-up: the welcome page (`/?welcome=1`, the form's 303) is ready
 * for the next `page.goto()`. `toHaveURL` passes as soon as the redirect commits, while
 * the page is still loading and starting its router. In WebKit a navigation started then
 * fails with "interrupted by another navigation to /?welcome=1": a navigation trace shows
 * WebKit requesting the welcome document again ~50 ms after `goto` starts, while the
 * page's startup requests are in flight (no app code navigates there). Waiting for load,
 * the router's start and network idle removes the race (0 failures in 36 parallel
 * WebKit runs, against 2–6 in 10 before).
 */
export async function waitForWelcome(page: Page): Promise<void> {
	await page.waitForURL(/\/\?welcome=1$/, { waitUntil: "load" });
	await waitForRouter(page);
	await page.waitForLoadState("networkidle");
}

/** Waits until the Turnstile widget has put its token in the form (test keys pass at once). */
export async function waitForTurnstile(page: Page): Promise<void> {
	await expect(page.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
}

/**
 * Makes a signed-in 18+ account ready to sell (D55, D70): verifies its email through the
 * captured outbox. Selling needs no phone (D70).
 */
export async function verifySeller(page: Page, email: string): Promise<void> {
	await page.goto(await linkFromEmail(page.request, email, "Confirm your email"));
	await waitForRouter(page);
}

export async function signOut(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}
