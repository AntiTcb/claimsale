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
	await page.getByRole("button", { name: "Create account" }).click();
}

export async function signOut(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}
