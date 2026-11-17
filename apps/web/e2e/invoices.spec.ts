import AxeBuilder from "@axe-core/playwright";
import type { Browser, Page } from "@playwright/test";
import { linkFromEmail, newIdentity, signUp, waitForWelcome, type Identity } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";
import { photo, signedUpSeller, startSale, timestampAndChecks } from "./sell-helpers.ts";

// Invoices after close (M8, WS-J): a seller publishes a sale with a shipping menu, two
// buyers claim, the seller closes and sends the invoices, the buyers pay with an address,
// the seller confirms and ships one with tracking by hand and the other through a tracking
// re-import, a buyer confirms receipt, and the seller downloads the orders export.

/** A verified buyer with a saved address, in their own browser context. */
async function signedUpBuyer(browser: Browser): Promise<{ page: Page; who: Identity }> {
	const context = await browser.newContext();
	const page = await context.newPage();
	const who = newIdentity("buyer");
	await signUp(page, who);
	await waitForWelcome(page);
	await page.goto(await linkFromEmail(page.request, who.email, "Confirm your email"));
	await page.goto("/me/addresses");
	await page.getByLabel("Full name").fill(`Ash ${who.handle}`);
	await page.getByLabel("Street address").fill("1 Route 1");
	await page.getByLabel("City").fill("Pallet");
	await page.getByLabel("State").fill("CA");
	await page.getByLabel("ZIP code").fill("94107");
	await page.getByRole("button", { name: "Save address" }).click();
	await expect(page.getByText("Address saved.")).toBeVisible();
	return { page, who };
}

async function addItem(page: Page, title: string, price: string): Promise<void> {
	const form = page.getByRole("form", { name: "Add an item" });
	await form.getByLabel("Title").fill(title);
	await form.getByLabel("Price ($)").fill(price);
	await form.getByLabel("Price ($)").press("Enter");
	await expect(page.getByTestId("item-row").last().getByRole("textbox", { name: "Title" })).toHaveValue(
		title,
	);
	await page
		.getByLabel(`Add photos for ${title}`)
		.setInputFiles(await photo(page, title.length % 2 ? "#cc5522" : "#2255cc"));
	await expect(page.getByRole("img", { name: `Photo 1 of ${title}` })).toBeVisible();
}

async function accessible(page: Page): Promise<void> {
	const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
	expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

/** The buyer claims an item through the entries endpoint (the live grid's button is WS-H). */
async function claim(buyer: Page, saleId: string, salePath: string, itemTitle: string): Promise<void> {
	await buyer.goto(salePath);
	const href = await buyer.getByRole("link", { name: new RegExp(itemTitle) }).getAttribute("href");
	const itemId = href!.split("/i/")[1]!;
	const response = await buyer.request.post(`/api/sales/${saleId}/entries`, {
		data: { itemId, kind: "claim" },
	});
	expect(response.ok(), await response.text()).toBe(true);
}

/** The buyer opens the sale's invoice and says "I've paid". */
async function pay(buyer: Page, saleTitle: string, reference: string): Promise<void> {
	await buyer.goto("/me/invoices");
	await buyer.getByRole("link", { name: saleTitle }).click();
	await expect(buyer.getByTestId("invoice-status")).toHaveText("Awaiting payment");
	await expect(buyer.getByTestId("payment-handles")).toContainText("@e2e-seller");
	await buyer.getByLabel("Payment reference (optional)").fill(reference);
	await buyer.getByRole("button", { name: "I've paid" }).click();
	await expect(buyer.getByTestId("invoice-status")).toHaveText("Marked paid");
}

test.describe("invoices", () => {
	test("close → invoice → paid → shipped → completed, with the orders export and a tracking re-import @critical", async ({
		page,
		browser,
	}) => {
		// Waits for the engine's photo checks and the export queue.
		test.slow();
		await signedUpSeller(page);
		const title = `Invoice test ${Date.now().toString(36)}`;
		await startSale(page, title);
		await addItem(page, "Charizard ex 199", "25");
		await addItem(page, "Pikachu promo", "5");
		const saleId = page.url().match(/\/sell\/([^/?]+)\/items/)![1]!;

		// Shipping and payment: the suggested menu and a payment handle.
		await page.goto(`/sell/${saleId}/shipping`);
		await expect(page.getByLabel("Option 1 name")).toHaveValue("Plain white envelope (untracked)");
		await page.waitForLoadState("networkidle");
		await accessible(page);
		await page.getByLabel("PayPal Goods & Services").fill("@e2e-seller");
		await page.getByRole("button", { name: "Save shipping and payment" }).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");

		await page.goto(`/sell/${saleId}`);
		await timestampAndChecks(page);
		await page.getByLabel("Go live now").check();
		await page.getByLabel("Runs for").selectOption("1");
		await page.getByRole("button", { name: "Go live now" }).click();
		await expect(page.getByText(/^Live until/)).toBeVisible();
		const salePath = (await page.getByRole("link", { name: "View sale page" }).getAttribute("href"))!;

		const ash = await signedUpBuyer(browser);
		const misty = await signedUpBuyer(browser);
		await claim(ash.page, saleId, salePath, "Charizard ex 199");
		await claim(misty.page, saleId, salePath, "Pikachu promo");

		// The seller closes the sale and sends both invoices.
		await page.goto(`/sell/${saleId}/buyers`);
		await expect(page.getByTestId("buyer-invoice")).toHaveCount(2);
		await page.getByRole("button", { name: "Close the sale now" }).click();
		await expect(page.getByText("The sale is closed.")).toBeVisible();
		await page.getByRole("button", { name: "Send all 2 invoices" }).click();
		await expect(page.getByText("Sent 2 invoices.")).toBeVisible();
		await accessible(page);

		// $25 is over the free seller's $20 threshold: only tracked shipping is offered.
		await ash.page.goto("/me/invoices");
		await ash.page.getByRole("link", { name: title }).click();
		await expect(ash.page.getByRole("radio")).toHaveCount(1);
		await expect(ash.page.getByRole("radio", { name: /USPS Ground Advantage/ })).toBeChecked();
		await ash.page.waitForLoadState("networkidle");
		await accessible(ash.page);
		await pay(ash.page, title, "PP-123");
		await expect(ash.page.getByTestId("invoice-total")).toHaveText("$30.50");
		await pay(misty.page, title, "PP-456");

		// The seller confirms Ash's payment and ships with tracking (required above the threshold).
		await page.reload();
		await page.getByRole("link", { name: new RegExp(`for @${ash.who.handle}`) }).click();
		await expect(page.getByTestId("ship-to")).toContainText("1 Route 1");
		await page.getByRole("button", { name: "Confirm payment received" }).click();
		await expect(page.getByTestId("invoice-status")).toHaveText("Paid");
		await page.getByRole("button", { name: "Mark shipped" }).click();
		await expect(page.getByRole("alert")).toHaveText("This order needs a tracking number");
		await page.getByLabel("Tracking number").fill("9400 1000 0000 0000 0000 00");
		await page.getByRole("button", { name: "Mark shipped" }).click();
		await expect(page.getByTestId("invoice-status")).toHaveText("Shipped");
		await expect(page.getByTestId("tracking")).toContainText("USPS");
		await accessible(page);

		// Ash confirms receipt.
		await ash.page.reload();
		await expect(ash.page.getByTestId("tracking")).toContainText("9400 1000 0000 0000 0000 00");
		await ash.page.getByRole("button", { name: "I received it" }).click();
		await expect(ash.page.getByTestId("invoice-status")).toHaveText("Completed");

		// The seller confirms Misty's payment, then ships it through a tracking re-import.
		await page.goto(`/sell/${saleId}/buyers`);
		const mistyLink = page.getByRole("link", { name: new RegExp(`for @${misty.who.handle}`) });
		const mistyNumber = (await mistyLink.textContent())!.match(/CS-\d+/)![0];
		await mistyLink.click();
		await page.getByRole("button", { name: "Confirm payment received" }).click();
		await expect(page.getByTestId("invoice-status")).toHaveText("Paid");

		await page.goto(`/sell/${saleId}/tracking-import`);
		await page.getByLabel("Tracking file").setInputFiles({
			name: "labels.csv",
			mimeType: "text/csv",
			buffer: Buffer.from(`Order ID,Tracking Number\r\n${mistyNumber},1Z999AA10123456784\r\n`),
		});
		await expect(page.getByTestId("tracking-row")).toContainText("Will mark shipped");
		await expect(page.getByLabel("Carrier for row 2")).toHaveValue("UPS");
		await page.getByRole("button", { name: "Apply 1 row" }).click();
		await expect(page.getByTestId("tracking-row")).toContainText("Marked shipped");
		await misty.page.reload();
		await expect(misty.page.getByTestId("invoice-status")).toHaveText("Shipped");
		await expect(misty.page.getByTestId("tracking")).toContainText("1Z999AA10123456784");

		// Orders export: built on the queue, downloadable for 24h, with no email in it.
		await page.goto(`/sell/exports?sale=${saleId}`);
		await page.getByLabel("Export", { exact: true }).selectOption("orders");
		await page.getByRole("button", { name: "Export CSV" }).click();
		await expect(page.getByText("Export requested.")).toBeVisible();
		const download = page.getByRole("link", { name: /^Download/ }).first();
		await expect(download).toBeVisible({ timeout: 45_000 });
		const response = await page.request.get((await download.getAttribute("href"))!);
		expect(response.headers()["content-disposition"]).toMatch(/^attachment; filename="claimsale-orders-/);
		const csv = await response.text();
		expect(csv).toContain(mistyNumber);
		expect(csv).toContain(`Ash ${misty.who.handle}`);
		expect(csv).toContain("1Z999AA10123456784");
		expect(csv).not.toContain("@example.test");

		await ash.page.context().close();
		await misty.page.context().close();
	});
});
