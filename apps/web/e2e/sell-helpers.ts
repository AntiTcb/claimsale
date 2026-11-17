import type { Page } from "@playwright/test";
import { newIdentity, outboxAvailable, signUp, smsCaptureAvailable, verifySeller } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";

/** Shared steps for the selling specs (sell.spec.ts, import.spec.ts). */

/** A real PNG drawn in the page, so the browser-side resize can decode it. */
export async function photo(
	page: Page,
	color: string,
): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
	const dataUrl = await page.evaluate((fill) => {
		const canvas = document.createElement("canvas");
		canvas.width = 2400;
		canvas.height = 1600;
		const context = canvas.getContext("2d")!;
		context.fillStyle = fill;
		context.fillRect(0, 0, canvas.width, canvas.height);
		return canvas.toDataURL("image/png");
	}, color);
	return {
		name: `${color.slice(1)}.png`,
		mimeType: "image/png",
		buffer: Buffer.from(dataUrl.split(",")[1]!, "base64"),
	};
}

/** `datetime-local` text for `days` from now, in the browser's own time zone. */
export function localDateTime(page: Page, days: number): Promise<string> {
	return page.evaluate((d) => {
		// Runs in the page, so no helpers from this module: sv-SE formats as "YYYY-MM-DD HH:mm".
		const at = new Date(Date.now() + d * 86_400_000);
		return at
			.toLocaleString("sv-SE", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			})
			.replace(" ", "T");
	}, days);
}

/**
 * Signs up a new 18+ seller, waits until the post-sign-up redirect has fully loaded,
 * and verifies their email and phone (D55) through capture mode.
 */
export async function signedUpSeller(page: Page): Promise<void> {
	test.skip(
		!(await outboxAvailable(page.request)) || !(await smsCaptureAvailable(page.request)),
		"Captured email and phone codes aren't readable here",
	);
	const seller = newIdentity("seller");
	await signUp(page, seller);
	// WebKit: navigating before this load finishes interrupts it ("/?welcome=1").
	await page.waitForURL(/\/\?welcome=1$/, { waitUntil: "load" });
	await page.waitForLoadState("networkidle");
	await expect(page.getByRole("link", { name: `@${seller.handle}` })).toBeVisible();
	await verifySeller(page, seller.email);
}

export async function startSale(page: Page, title: string): Promise<void> {
	await page.goto("/sell");
	await page.getByRole("link", { name: "New sale" }).click();
	await page.getByLabel("Title").fill(title);
	await page.getByRole("button", { name: "Continue to terms" }).click();
	await expect(page.getByRole("heading", { name: "Terms" })).toBeVisible();
	// The terms form is enhanced; in WebKit a click while it hydrates can be dropped.
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "Continue to items" }).click();
	await expect(page.getByRole("heading", { name: "Items" })).toBeVisible();
	// Fast entry is enhanced by JavaScript; without it Enter is a plain POST (which also works).
	await page.waitForLoadState("networkidle");
}
