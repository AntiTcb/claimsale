import type { Page } from "@playwright/test";
import { newIdentity, outboxAvailable, signUp, smsCaptureAvailable, verifySeller } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";

// Sales and items (milestone 4, WS-A): a seller creates a draft through the wizard,
// adds items with photos in the table editor, schedules the sale, and a signed-out
// visitor views it at /s/[slug].

/** A real PNG drawn in the page, so the browser-side resize can decode it. */
async function photo(page: Page, color: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
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
function localDateTime(page: Page, days: number): Promise<string> {
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
async function signedUpSeller(page: Page): Promise<void> {
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

async function startSale(page: Page, title: string): Promise<void> {
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

async function addItem(page: Page, title: string, price: string): Promise<void> {
	const form = page.getByRole("form", { name: "Add an item" });
	await form.getByLabel("Title").fill(title);
	await form.getByLabel("Price ($)").fill(price);
	await form.getByLabel("Price ($)").press("Enter");
	await expect(page.getByTestId("item-row").last().getByRole("textbox", { name: "Title" })).toHaveValue(
		title,
	);
	// Fast entry: focus goes back to the title for the next item.
	await expect(form.getByLabel("Title")).toBeFocused();
}

test.describe("selling", () => {
	test("a seller drafts a sale, adds items with photos and schedules it; a visitor views it @critical", async ({
		page,
		browser,
		expectAccessible,
	}) => {
		await signedUpSeller(page);

		const title = `Weekend YGO singles ${Date.now().toString(36)}`;
		await startSale(page, title);
		await expectAccessible();
		await addItem(page, "Blue-Eyes White Dragon LOB-001", "40");
		await addItem(page, "Dark Magician SDY-006", "12.50");
		await expect(page.getByTestId("item-row")).toHaveCount(2);

		for (const [item, color] of [
			["Blue-Eyes White Dragon LOB-001", "#2255cc"],
			["Dark Magician SDY-006", "#8822aa"],
		] as const) {
			await page.getByLabel(`Add photos for ${item}`).setInputFiles(await photo(page, color));
			await expect(page.getByRole("img", { name: `Photo 1 of ${item}` })).toBeVisible();
		}
		const img = page.getByRole("img", { name: "Photo 1 of Dark Magician SDY-006" });
		// Thumbnails load lazily: on a phone the photo column sits off-screen in the table's
		// horizontal scroll, and WebKit only fetches lazy images once they are near the viewport.
		await img.scrollIntoViewIfNeeded();
		await expect
			.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
			.toBe(2000);

		// Regression: the dropzone's visually hidden (absolute) input escaped the table's scroll
		// box and widened the whole page on phones, so taps landed on the wrong elements. (So did a
		// long handle in the site header; see SiteHeader.svelte.test.ts.)
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			page.viewportSize()!.width,
		);
		// Reorder with the keyboard-accessible buttons; the order is saved before the reload.
		const saved = page.waitForResponse(
			(r) => r.url().includes("?/reorder") && r.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Move Dark Magician SDY-006 up" }).click();
		expect((await saved).ok()).toBe(true);
		await expect(page.getByTestId("item-row").first().getByRole("textbox", { name: "Title" })).toHaveValue(
			"Dark Magician SDY-006",
		);
		// Let the post-save data refresh finish; WebKit aborts a reload that races it.
		await page.waitForLoadState("networkidle");
		await page.reload();
		await expect(page.getByTestId("item-row").first().getByRole("textbox", { name: "Title" })).toHaveValue(
			"Dark Magician SDY-006",
		);

		await page.getByRole("link", { name: "Next: schedule the sale" }).click();
		await page.getByLabel("Goes live at (your time)").fill(await localDateTime(page, 2));
		await page.getByLabel("Runs for").selectOption("3");
		await page.getByRole("button", { name: "Schedule sale" }).click();
		await expect(page.getByText(/^Scheduled\. Goes live/)).toBeVisible();
		const salePath = await page.getByRole("link", { name: "View sale page" }).getAttribute("href");
		expect(salePath).toMatch(/^\/s\/weekend-ygo-singles-/);

		const visitor = await browser.newContext();
		const anon = await visitor.newPage();
		await anon.goto(salePath!);
		await expect(anon.getByRole("heading", { level: 1, name: title })).toBeVisible();
		await expect(anon.getByText(/^Preview\. Claims open/)).toBeVisible();
		await expect(anon.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
		const cards = anon.getByRole("listitem").getByRole("link");
		await expect(cards).toHaveCount(2);
		await expect(cards.first()).toContainText("Dark Magician SDY-006");
		await expect(cards.first()).toContainText("$12.50");
		const thumb = cards.first().locator("img");
		await thumb.scrollIntoViewIfNeeded();
		await expect
			.poll(() => thumb.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
			.toBe(2000);

		await cards.nth(1).click();
		await expect(
			anon.getByRole("heading", { level: 1, name: "Blue-Eyes White Dragon LOB-001" }),
		).toBeVisible();
		await expect(anon.getByText("$40.00")).toBeVisible();
		await expect(anon.getByRole("img", { name: /Photo 1 of 1: Blue-Eyes/ })).toBeVisible();
		await visitor.close();
	});

	test("a draft and its photos stay hidden from everyone but the seller", async ({ page, browser }) => {
		await signedUpSeller(page);
		await startSale(page, "Secret draft");
		await addItem(page, "Charizard Base Set", "300");
		await page.getByLabel("Add photos for Charizard Base Set").setInputFiles(await photo(page, "#ee5511"));
		const img = page.getByRole("img", { name: "Photo 1 of Charizard Base Set" });
		await expect(img).toBeVisible();
		const imageUrl = await img.getAttribute("src");

		await page.getByRole("link", { name: "Overview" }).click();
		const salePath = await page.getByRole("link", { name: /Preview \(only you/ }).getAttribute("href");
		await page.goto(salePath!);
		await expect(page.getByText("This is a draft. Only you can see it.")).toBeVisible();

		const visitor = await browser.newContext();
		const anon = await visitor.newPage();
		expect((await anon.goto(salePath!))?.status()).toBe(404);
		expect((await anon.request.get(imageUrl!)).status()).toBe(404);
		await visitor.close();
	});

	test("publishing explains what's missing", async ({ page }) => {
		await signedUpSeller(page);
		await startSale(page, "Not ready yet");
		await addItem(page, "Pikachu promo", "5");
		await page.getByRole("link", { name: "Next: schedule the sale" }).click();
		await expect(page.getByText("1 item needs a photo")).toBeVisible();
		await page.getByLabel("Go live now").check();
		await page.getByRole("button", { name: "Go live now" }).click();
		await expect(page.getByRole("alert")).toHaveText(
			"Add at least one photo to every item before publishing",
		);
	});
});
