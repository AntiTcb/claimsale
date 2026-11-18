import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { signOut } from "./auth-helpers.ts";
import {
	localDateTime,
	photo,
	signedUpSeller,
	startSale,
	timestampAndChecks,
	waitForChecks,
} from "./sell-helpers.ts";

// Sales and items (milestone 4, WS-A): a seller creates a draft through the wizard,
// adds items with photos in the table editor, schedules the sale, and a signed-out
// visitor views it at /s/[slug].

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
		// Waits for the engine's photo checks, which the queue batches for a few seconds.
		test.slow();
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
		await expect(page.getByRole("heading", { name: "Timestamp photo (required)" })).toBeVisible();
		await timestampAndChecks(page);
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
		await expect(anon.getByText("Timestamped", { exact: true })).toBeVisible();
		await expect(anon.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
		// The live grid's cards (WS-H): the title is the card's link; the buttons sit beside it.
		const cards = anon.getByTestId("live-item");
		await expect(cards).toHaveCount(2);
		await expect(cards.first()).toContainText("Dark Magician SDY-006");
		await expect(cards.first()).toContainText("$12.50");
		const thumb = cards.first().locator("img");
		await thumb.scrollIntoViewIfNeeded();
		await expect
			.poll(() => thumb.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
			.toBe(2000);

		await expect(
			cards.first().getByRole("button", { name: "Claims open soon for Dark Magician SDY-006" }),
		).toBeDisabled();
		await cards.nth(1).getByRole("link", { name: "Blue-Eyes White Dragon LOB-001" }).click();
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

test.describe("photo authenticity", () => {
	test("another seller's photo is rejected without naming them; the admin queue is for admins", async ({
		page,
		browser,
		expectAccessible,
	}) => {
		// Two sellers and two rounds of photo checks (queued in batches).
		test.slow();
		// Seller A's photo is checked and approved first.
		const first = await signedUpSeller(page);
		await startSale(page, "Original photos");
		await addItem(page, "Mew promo", "20");
		const shot = await photo(page, "#33aa77");
		await page.getByLabel("Add photos for Mew promo").setInputFiles(shot);
		await expect(page.getByRole("img", { name: "Photo 1 of Mew promo" })).toBeVisible();
		await waitForChecks(page);
		await expect(page.getByTestId("photo-rejection")).toHaveCount(0);

		// Seller B uploads the same photo.
		const other = await browser.newContext();
		const copier = await other.newPage();
		await signedUpSeller(copier);
		await startSale(copier, "Copied photos");
		await addItem(copier, "Mew promo", "18");
		await copier.getByLabel("Add photos for Mew promo").setInputFiles(shot);
		await expect(copier.getByRole("img", { name: "Photo 1 of Mew promo" })).toBeVisible();
		await waitForChecks(copier);
		const rejection = copier.getByTestId("photo-rejection");
		await expect(rejection).toHaveText(
			"Photo 1 was rejected: This photo matches an image already used on ClaimSale. Please upload your own photo.",
		);
		await expect(copier.getByText(first.handle)).toHaveCount(0);
		// It can't be published with it.
		await copier.getByRole("link", { name: "Next: schedule the sale" }).click();
		await expect(copier.getByText("1 item needs a photo")).toBeVisible();

		// /admin is invisible to sellers, and open to admins.
		expect((await copier.goto("/admin"))?.status()).toBe(404);
		await other.close();
		// A JSON body: SvelteKit refuses cross-site form posts.
		const granted = await page.request.post(`/api/test/admin?email=${encodeURIComponent(first.email)}`, {
			data: {},
		});
		expect(await granted.json()).toEqual({ updated: 1 });
		await page.goto("/admin");
		await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
		await expect(page.getByRole("heading", { name: /^Photos held for review/ })).toBeVisible();
		await expect(page.getByRole("heading", { name: /^Flagged accounts/ })).toBeVisible();
		await expectAccessible();
		await signOut(page);
		await page.goto("/admin");
		await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);
	});
});
