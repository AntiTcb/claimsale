import type { Page } from "@playwright/test";
import {
	newIdentity,
	outboxAvailable,
	signUp,
	smsCaptureAvailable,
	verifySeller,
	waitForWelcome,
	type Identity,
	waitForRouter,
} from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";

/** Shared steps for the selling specs (sell.spec.ts, import.spec.ts). */

/**
 * A real PNG drawn in the page, so the browser-side resize can decode it. Random shapes
 * on the colour make every photo unique: the duplicate check (D63) rejects a photo that
 * matches any other seller's, and E2E runs share one database.
 */
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
		for (let i = 0; i < 60; i++) {
			const shade = Math.floor(Math.random() * 256);
			context.fillStyle = `rgb(${shade}, ${255 - shade}, ${Math.floor(Math.random() * 256)})`;
			context.fillRect(
				Math.random() * canvas.width,
				Math.random() * canvas.height,
				100 + Math.random() * 700,
				100 + Math.random() * 500,
			);
		}
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
export async function signedUpSeller(page: Page): Promise<Identity> {
	test.skip(
		!(await outboxAvailable(page.request)) || !(await smsCaptureAvailable(page.request)),
		"Captured email and phone codes aren't readable here",
	);
	const seller = newIdentity("seller");
	await signUp(page, seller);
	await waitForWelcome(page);
	await expect(page.getByRole("link", { name: `@${seller.handle}` })).toBeVisible();
	await verifySeller(page, seller.email);
	return seller;
}

/**
 * On the sale overview: adds the timestamp photo (D66, required for new sellers) and
 * waits until the engine's photo check has approved every photo (IMG-required).
 */
export async function timestampAndChecks(page: Page): Promise<void> {
	await page.getByLabel("Add a timestamp photo").setInputFiles(await photo(page, "#f5e6c8"));
	await expect(page.getByText("Timestamp photo uploaded.")).toBeAttached();
	await waitForChecks(page);
	await expect(page.getByTestId("timestamp-status")).toContainText("Approved");
}

/** Reloads the current page until no photo is still being checked (the queue batches for a few seconds). */
export async function waitForChecks(page: Page): Promise<void> {
	await expect
		.poll(
			async () => {
				// WebKit: a reload while the page is still navigating or refreshing its data (after an
				// upload, or the previous reload's startup) fails with "Frame load interrupted".
				await page.waitForLoadState("networkidle");
				await page.reload();
				return (
					(await page.getByText(/being checked/i).count()) +
					(await page.getByText("Checking", { exact: true }).count())
				);
			},
			{ message: "photo checks to finish", timeout: 45_000, intervals: [1000, 2000] },
		)
		.toBe(0);
	// WebKit: a field filled while the reloaded page hydrates can lose its value.
	await page.waitForLoadState("networkidle");
}

export async function startSale(page: Page, title: string): Promise<void> {
	await page.goto("/sell");
	// WebKit: a click on a link before the router has started can be dropped (waitForRouter).
	await waitForRouter(page);
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
