import type { Browser, Page } from "@playwright/test";
import { linkFromEmail, newIdentity, signUp, waitForWelcome, type Identity } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";
import { photo, signedUpSeller, startSale, timestampAndChecks } from "./sell-helpers.ts";

// The seller control room (WS-I): two buyers claim an item in a "review every claim"
// sale; the seller awards the first, then rescinds with a reason and passes it to the
// next in line. The rescinded buyer contests, and an admin resolves the dispute.

async function buyer(browser: Browser): Promise<{ page: Page; who: Identity; close: () => Promise<void> }> {
	const context = await browser.newContext();
	const page = await context.newPage();
	const who = newIdentity("buyer");
	await signUp(page, who);
	await waitForWelcome(page);
	// D20: claims need a verified email.
	await page.goto(await linkFromEmail(page.request, who.email, "Confirm your email"));
	return { page, who, close: () => context.close() };
}

async function claim(page: Page, saleId: string, itemId: string) {
	const res = await page.request.post(`/api/sales/${saleId}/entries`, { data: { itemId, kind: "claim" } });
	expect(res.ok(), await res.text()).toBe(true);
	return (await res.json()) as { entry: { status: string } };
}

test.describe("seller control room", () => {
	test("a seller awards a claim, then rescinds it with a reason and passes it on; the buyer contests and an admin decides", async ({
		page,
		browser,
		expectAccessible,
	}) => {
		// Photo checks, three accounts and a dispute.
		test.slow();
		const seller = await signedUpSeller(page);
		const title = `Control room ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		await startSale(page, title);
		const saleId = /\/sell\/([^/]+)\/items/.exec(page.url())![1]!;
		const form = page.getByRole("form", { name: "Add an item" });
		await form.getByLabel("Title").fill("Charizard Base Set");
		await form.getByLabel("Price ($)").fill("40");
		await form.getByLabel("Price ($)").press("Enter");
		await expect(page.getByTestId("item-row")).toHaveCount(1);
		await page.getByLabel("Add photos for Charizard Base Set").setInputFiles(await photo(page, "#cc5522"));
		await expect(page.getByRole("img", { name: "Photo 1 of Charizard Base Set" })).toBeVisible();

		// Every claim waits for the seller (D34), so the control room decides.
		await page.goto(`/sell/${saleId}/terms`);
		await page.waitForLoadState("networkidle");
		await page.getByLabel("Review every claim before it wins").check();
		await expect(page.getByLabel("Decision window (hours)")).toBeDisabled();
		await page.getByRole("button", { name: "Save terms" }).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");

		await page.goto(`/sell/${saleId}`);
		// The timestamp upload is handled by the page's JavaScript.
		await page.waitForLoadState("networkidle");
		await timestampAndChecks(page);
		await page.getByLabel("Go live now").check();
		await page.getByRole("button", { name: "Go live now" }).click();
		const salePath = await page.getByRole("link", { name: "View sale page" }).getAttribute("href");
		await page.goto(salePath!);
		const itemHref = await page.getByRole("listitem").getByRole("link").first().getAttribute("href");
		const itemId = itemHref!.split("/").at(-1)!;

		const ash = await buyer(browser);
		const misty = await buyer(browser);
		expect((await claim(ash.page, saleId, itemId)).entry.status).toBe("open");
		expect((await claim(misty.page, saleId, itemId)).entry.status).toBe("open");

		await page.goto(`/sell/${saleId}`);
		await page.getByRole("link", { name: "Control room" }).click();
		await expect(page.getByRole("heading", { level: 1, name: "Control room" })).toBeVisible();
		await expect(page.getByTestId("countdown")).toContainText("Decide within");
		const queue = page.getByTestId("queue-entry");
		await expect(queue).toHaveCount(2);
		await expect(queue.first()).toContainText(`#1 @${ash.who.handle}`);
		await expect(queue.first()).toContainText("0 completed");
		await expectAccessible();

		await page.getByRole("button", { name: `Award @${ash.who.handle}` }).click();
		await expect(page.getByRole("status")).toHaveText("Awarded.");
		await expect(page.getByTestId("winner")).toContainText(`@${ash.who.handle}`);
		await expect(queue).toHaveCount(1);

		await page.getByText(`Rescind @${ash.who.handle}'s win`).click();
		await page.getByRole("combobox", { name: "Reason" }).selectOption("seller_listing_error");
		await page
			.getByRole("textbox", { name: "What happened (the buyer sees this)" })
			.fill("I listed the wrong edition; this one is unlimited.");
		await expect(page.getByLabel("Pass it to the next in line")).toBeChecked();
		await page.getByRole("button", { name: "Rescind", exact: true }).click();
		await expect(page.getByRole("status")).toHaveText("Rescinded and passed to the next in line.");
		// Misty's claim at asking is promoted automatically (SM-4.3-promote-auto).
		await expect(page.getByTestId("winner")).toContainText(`@${misty.who.handle}`);
		await expect(queue).toHaveCount(0);
		await expect(page.getByTestId("rescind")).toContainText("Listing mistake");
		await expect(page.getByTestId("rescind")).toContainText("Final");
		await misty.close();

		// Ash sees the reason and contests it.
		await ash.page.goto("/me/rescinds");
		const mine = ash.page.getByTestId("my-rescind");
		await expect(mine).toContainText("I listed the wrong edition");
		await ash.page.getByText(/^Contest \(until/).click();
		await ash.page
			.getByLabel("Your side (an admin reads it)")
			.fill("The listing photo shows the 1st edition stamp.");
		await ash.page.getByRole("button", { name: "Send contest" }).click();
		await expect(ash.page.getByRole("status")).toContainText("Contest sent");
		await expect(mine).toContainText("Contested; an admin will decide");
		await ash.close();

		// The seller becomes an admin (test endpoint) and resolves the dispute. E2E runs share
		// one database, so the dispute is found by this test's unique sale title.
		const granted = await page.request.post(`/api/test/admin?email=${encodeURIComponent(seller.email)}`, {
			data: {},
		});
		expect(await granted.json()).toEqual({ updated: 1 });
		await page.goto("/admin/rescinds");
		const disputed = page.getByTestId("disputed-rescind").filter({ hasText: title });
		await expect(disputed).toBeVisible();
		await expectAccessible();
		await disputed.getByLabel("Seller").check();
		await disputed.getByRole("button", { name: /^Resolve/ }).click();
		await expect(page.getByRole("status")).toHaveText("Rescind resolved.");
		await expect(page.getByTestId("disputed-rescind").filter({ hasText: title })).toHaveCount(0);
	});
});
