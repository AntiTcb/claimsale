import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { newIdentity, signUp, waitForRouter, waitForWelcome } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";
import { publicSaleWithItem, signedUpSeller } from "./sell-helpers.ts";

// Discovery (milestone 10, WS-L): a seller schedules a public sale; a buyer finds it by
// game, by search and on the browse page, follows the seller from the sale and reports
// it; the seller copies the sale as text for a Facebook post.

async function expectAccessibleOn(target: Page): Promise<void> {
	const results = await new AxeBuilder({ page: target })
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.analyze();
	expect(results.violations.map((v) => v.id)).toEqual([]);
}

test.describe("discovery", () => {
	test("a public sale shows up by game, in search and on browse; a buyer follows and reports it @critical", async ({
		page,
		browser,
	}) => {
		// Photo checks batch for a few seconds.
		test.slow();
		await signedUpSeller(page);
		const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		const title = `Discovery sale ${id}`;
		const itemTitle = `Pikachu ${id} promo`;
		// A price no other test uses, so the game page can be filtered down to this item.
		// Under $1,000, so the text export shows it without a thousands separator.
		const price = `${100 + Math.floor(Math.random() * 900)}.${10 + Math.floor(Math.random() * 90)}`;
		const salePath = await publicSaleWithItem(page, title, { title: itemTitle, price, game: "Pokémon" });

		// The seller copies the item list for a Facebook post (DISC-copy-text).
		await page.getByRole("link", { name: "Overview" }).click();
		await waitForRouter(page);
		await page.getByRole("button", { name: "Copy as text" }).click();
		const text = page.getByLabel("Sale as text");
		await expect(text).toHaveValue(new RegExp(`^${title}\\nGoes live `));
		// The add form's default condition sits between the title and the price.
		await expect(text).toHaveValue(
			new RegExp(`1\\. ${itemTitle} · [A-Z]+ · \\$${price.replace(".", "\\.")}`),
		);
		await expect(text).toHaveValue(new RegExp(`Claim here: http\\S+${salePath}$`));

		const buyerContext = await browser.newContext();
		const buyer = await buyerContext.newPage();
		await signUp(buyer, newIdentity("buyer"));
		await waitForWelcome(buyer);

		// By game, filtered to this item's price.
		await buyer.goto(`/g/pokemon?min=${price}&max=${price}`);
		const gameItems = buyer.getByTestId("game-items").getByRole("listitem");
		await expect(gameItems).toHaveCount(1);
		await expect(gameItems.first()).toContainText(itemTitle);
		await expect(gameItems.first()).toContainText(title);
		await expectAccessibleOn(buyer);

		// Search finds the item and the sale.
		await buyer.goto("/browse");
		await waitForRouter(buyer);
		await buyer.getByRole("searchbox", { name: "Search cards and sales" }).fill(`pikachu ${id}`);
		await buyer.getByRole("button", { name: "Search" }).click();
		await expect(buyer).toHaveURL(/\/search\?q=pikachu/);
		await expect(buyer.getByTestId("item-results").getByRole("listitem")).toHaveCount(1);
		await expectAccessibleOn(buyer);
		await buyer.goto(`/search?q=${encodeURIComponent(`discovery sale ${id}`)}`);
		await expect(buyer.getByRole("link", { name: new RegExp(title) })).toHaveAttribute("href", salePath);

		// The sale page: follow the seller and report the sale.
		await buyer.goto(salePath);
		await waitForRouter(buyer);
		await buyer.getByRole("button", { name: /^Follow/ }).click();
		await expect(buyer.getByRole("button", { name: /^Unfollow/ })).toBeVisible();
		await buyer.locator("summary", { hasText: "Report this sale" }).click();
		await buyer.getByLabel("Reason").selectOption({ label: "Counterfeit, proxy or replica" });
		await buyer.getByLabel("Details (optional)").fill("Looks like a proxy");
		await buyer.getByRole("button", { name: "Send report" }).click();
		await expect(buyer.getByRole("status").filter({ hasText: "An admin will look at it" })).toBeVisible();

		// The landing page lists sellers you follow.
		await buyer.goto("/");
		await expect(buyer.getByTestId("followed-sales")).toContainText(title);
		await expectAccessibleOn(buyer);

		// Public sales are in the sitemap; signed-out visitors can browse too.
		const visitor = await browser.newContext();
		const anon = await visitor.newPage();
		const sitemap = await (await anon.request.get("/sitemap.xml")).text();
		expect(sitemap).toContain(`${salePath}</loc>`);
		await anon.goto(salePath);
		await expect(anon.getByRole("link", { name: "Report this sale" })).toHaveAttribute(
			"href",
			/^\/login\?next=/,
		);
		await anon.goto("/policies/prohibited-items");
		await expect(anon.getByRole("heading", { level: 1, name: "Prohibited items" })).toBeVisible();
		await expectAccessibleOn(anon);
		await visitor.close();
		await buyerContext.close();
	});
});
