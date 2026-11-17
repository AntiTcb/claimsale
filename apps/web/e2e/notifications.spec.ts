import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import { linkFromEmail, newIdentity, signUp, waitForRouter, waitForWelcome } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";
import { localDateTime, photo, signedUpSeller, timestampAndChecks } from "./sell-helpers.ts";

// Notifications and messaging (milestone 9, WS-K): a buyer follows a seller; the seller
// schedules a public sale; the follower's notification email lands in the capture outbox
// and the bell shows it. Then the buyer messages the seller, and the seller's reply reaches
// the buyer's open thread without a reload.

/** Waits for a captured email whose subject contains `subject`, and returns it. */
async function emailTo(request: APIRequestContext, to: string, subject: string) {
	let found: { subject: string; text: string } | undefined;
	await expect
		.poll(
			async () => {
				const res = await request.get(`/api/test/outbox?to=${encodeURIComponent(to)}`);
				const messages = (await res.json()) as Array<{ subject: string; text: string }>;
				found = messages.find((m) => m.subject.includes(subject));
				return found?.subject ?? "";
			},
			// The queue consumer batches for a few seconds.
			{ message: `email "${subject}" to ${to}`, timeout: 30_000, intervals: [1000, 2000] },
		)
		.toContain(subject);
	return found!;
}

async function publicSaleWithItem(page: Page, title: string): Promise<string> {
	await page.goto("/sell");
	await page.getByRole("link", { name: "New sale" }).click();
	await page.getByLabel("Title").fill(title);
	await page.getByRole("radio", { name: /^Public/ }).check();
	await page.getByRole("button", { name: "Continue to terms" }).click();
	await expect(page.getByRole("heading", { name: "Terms" })).toBeVisible();
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "Continue to items" }).click();
	await expect(page.getByRole("heading", { name: "Items" })).toBeVisible();
	await page.waitForLoadState("networkidle");
	const form = page.getByRole("form", { name: "Add an item" });
	await form.getByLabel("Title").fill("Charizard Base Set 4/102");
	await form.getByLabel("Price ($)").fill("250");
	await form.getByLabel("Price ($)").press("Enter");
	await expect(page.getByTestId("item-row")).toHaveCount(1);
	await page
		.getByLabel("Add photos for Charizard Base Set 4/102")
		.setInputFiles(await photo(page, "#cc5522"));
	await expect(page.getByRole("img", { name: "Photo 1 of Charizard Base Set 4/102" })).toBeVisible();
	await page.getByRole("link", { name: "Next: schedule the sale" }).click();
	await timestampAndChecks(page);
	await page.getByLabel("Goes live at (your time)").fill(await localDateTime(page, 2));
	await page.getByRole("button", { name: "Schedule sale" }).click();
	await expect(page.getByText(/^Scheduled\. Goes live/)).toBeVisible();
	return (await page.getByRole("link", { name: "View sale page" }).getAttribute("href"))!;
}

test.describe("notifications and messaging", () => {
	test("a follower is emailed about a new sale, sees it under the bell, and messages the seller @critical", async ({
		page,
		browser,
		expectAccessible,
	}) => {
		// Photo checks and the notifications queue each batch for a few seconds.
		test.slow();
		const seller = await signedUpSeller(page);

		// The buyer signs up, confirms their email (notification email goes to verified addresses
		// only, NOTIF-preferences) and follows the seller.
		const buyerContext = await browser.newContext();
		const buyerPage = await buyerContext.newPage();
		const buyer = newIdentity("buyer");
		await signUp(buyerPage, buyer);
		await waitForWelcome(buyerPage);
		await buyerPage.goto(await linkFromEmail(buyerPage.request, buyer.email, "Confirm your email"));
		await buyerPage.goto(`/u/${seller.handle}`);
		// WebKit: a click before the router starts is a plain POST that a late replaceState can undo on screen.
		await waitForRouter(buyerPage);
		await buyerPage.getByRole("button", { name: /^Follow/ }).click();
		await expect(buyerPage.getByRole("button", { name: /^Unfollow/ })).toBeVisible();
		await expect(buyerPage.getByText("1 follower", { exact: true })).toBeVisible();

		// SM-2-go-live-alarm (followers part): scheduling a public sale tells the followers.
		const title = `Vintage Pokémon ${Date.now().toString(36)}`;
		const salePath = await publicSaleWithItem(page, title);
		const mail = await emailTo(buyerPage.request, buyer.email, "scheduled a new sale");
		expect(mail.text).toContain(`“${title}” goes live`);
		expect(mail.text).toContain(salePath);

		// The bell counts it; opening it marks it read and goes to the sale.
		await buyerPage.goto("/");
		await expect(buyerPage.getByRole("link", { name: "Notifications, 1 unread" })).toBeVisible();
		await buyerPage.getByRole("link", { name: "Notifications, 1 unread" }).click();
		await expect(buyerPage.getByRole("heading", { name: "Notifications" })).toBeVisible();
		await expectAccessibleOn(buyerPage);
		await buyerPage.getByRole("button", { name: /scheduled a new sale/ }).click();
		await expect(buyerPage).toHaveURL(new RegExp(`${salePath}$`));
		await expect(buyerPage.getByRole("link", { name: "Notifications", exact: true })).toBeVisible();

		// Messaging (D18): the buyer asks before claiming; a payment handle gets the warning.
		await buyerPage.getByRole("link", { name: "Message the seller" }).click();
		await buyerPage.getByLabel("Message", { exact: true }).fill("Can I see the back? I can pay F&F.");
		await expect(buyerPage.getByRole("note")).toContainText("Payments belong on the invoice");
		await buyerPage.getByRole("button", { name: "Send" }).click();
		await expect(buyerPage).toHaveURL(/\/me\/messages\/[^/]+$/);
		await expect(buyerPage.getByText("Can I see the back? I can pay F&F.")).toBeVisible();
		await expect(buyerPage.getByRole("note")).toContainText("paying outside the invoice");

		// The seller sees it in their inbox and replies; the buyer's open thread picks it up.
		await page.goto("/me/messages");
		await page.getByRole("link", { name: new RegExp(buyer.displayName) }).click();
		await expect(page.getByText("Can I see the back? I can pay F&F.")).toBeVisible();
		await expectAccessible();
		await page.getByLabel(`Message ${buyer.displayName}`).fill("Sure, photo coming up.");
		await page.getByRole("button", { name: "Send" }).click();
		await expect(page.getByText("Sure, photo coming up.")).toBeVisible();
		await expect(buyerPage.getByText("Sure, photo coming up.")).toBeVisible({ timeout: 15_000 });
		await buyerContext.close();
	});
});

/** Runs axe on another context's page (the fixture is bound to `page`). */
async function expectAccessibleOn(target: Page): Promise<void> {
	const results = await new AxeBuilder({ page: target })
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.analyze();
	expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}
