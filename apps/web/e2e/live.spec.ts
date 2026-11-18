import type { Browser, Page } from "@playwright/test";
import { linkFromEmail, newIdentity, signUp, waitForWelcome } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";
import { photo, signedUpSeller, startSale, timestampAndChecks } from "./sell-helpers.ts";

// The live grid (milestone 6, WS-H): buyers on a live sale page see claims land over the
// sale's WebSocket, without reloading.

const ITEM = "Charizard Base Set 4/102";

/** A seller with a live sale of one $40 card; returns the sale page's path. */
async function liveSale(page: Page): Promise<string> {
	await signedUpSeller(page);
	await startSale(page, `Live grid ${Date.now().toString(36)}`);
	const form = page.getByRole("form", { name: "Add an item" });
	await form.getByLabel("Title").fill(ITEM);
	await form.getByLabel("Price ($)").fill("40");
	await form.getByLabel("Price ($)").press("Enter");
	await expect(page.getByTestId("item-row")).toHaveCount(1);
	await page.getByLabel(`Add photos for ${ITEM}`).setInputFiles(await photo(page, "#cc5522"));
	await expect(page.getByRole("img", { name: `Photo 1 of ${ITEM}` })).toBeVisible();
	await page.getByRole("link", { name: "Next: schedule the sale" }).click();
	await timestampAndChecks(page);
	await page.getByLabel("Go live now").check();
	await page.getByRole("button", { name: "Go live now" }).click();
	await expect(page.getByText(/^Live until/)).toBeVisible();
	return (await page.getByRole("link", { name: "View sale page" }).getAttribute("href"))!;
}

/** A buyer in their own browser context: signed up, email confirmed, on the sale page. */
async function buyerOn(browser: Browser, salePath: string): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	const who = newIdentity("buyer");
	await signUp(page, who);
	await waitForWelcome(page);
	await page.goto(await linkFromEmail(page.request, who.email, "Confirm your email"));
	// Claims need a verified email (D20).
	await page.goto("/me/settings");
	await expect(page.getByText("Verified.")).toBeVisible();
	await page.goto(salePath);
	await expect(page.getByTestId("connection")).toHaveText("Live");
	return page;
}

test.describe("the live grid", () => {
	test("two buyers claim the same card at once: one wins, one is backup, and every page updates live @critical", async ({
		page,
		browser,
		expectAccessible,
	}) => {
		// Waits for the engine's photo checks, which the queue batches for a few seconds.
		test.slow();
		const salePath = await liveSale(page);
		// The seller watches their own sale page.
		await page.goto(salePath);
		await expect(page.getByTestId("connection")).toHaveText("Live");

		const [ann, bob] = await Promise.all([buyerOn(browser, salePath), buyerOn(browser, salePath)]);
		await expectAccessible();

		// Both open the binding-claim confirmation, then confirm together.
		for (const buyer of [ann, bob]) {
			await buyer.getByRole("button", { name: `Claim ${ITEM}` }).click();
			await expect(buyer.getByRole("dialog", { name: `Claim ${ITEM}?` })).toBeVisible();
			await expect(buyer.getByText("Claims are binding. Claim for $40.00?")).toBeVisible();
		}
		await Promise.all(
			[ann, bob].map((buyer) => buyer.getByRole("button", { name: "Claim for $40.00" }).click()),
		);

		// Exactly one is #1 and the other is backup #1, each told in the live region.
		const positions = await Promise.all(
			[ann, bob].map(async (buyer) => {
				const badge = buyer.getByTestId("my-position");
				await expect(badge).toHaveText(/^(You're #1|Backup #1)$/);
				return (await badge.textContent())!.trim();
			}),
		);
		expect(positions.toSorted()).toEqual(["Backup #1", "You're #1"]);
		const winner = positions[0] === "You're #1" ? ann : bob;
		const backup = winner === ann ? bob : ann;
		await expect(winner.getByTestId("live-announcement")).toHaveText(`You're #1 — ${ITEM} is yours.`);
		await expect(backup.getByTestId("live-announcement")).toHaveText(`You're backup #1 for ${ITEM}.`);
		await expect(winner.getByTestId("running-total")).toHaveText("Your total: $40.00 · 1 item won");
		await expect(backup.getByTestId("running-total")).toBeHidden();

		// Both cards say sold out with one claim waiting behind the winner, and so does the
		// seller's page, all without a reload.
		for (const viewer of [winner, backup, page]) {
			await expect(viewer.getByTestId("item-state")).toHaveText("Sold out");
			await expect(viewer.getByTestId("item-counts")).toHaveText("1 claim waiting · 0 offers");
		}
		await expect(page.getByRole("button", { name: /Claim/ })).toHaveCount(0);

		// A reload shows the same from the server's snapshot.
		await backup.reload();
		await expect(backup.getByTestId("my-position")).toHaveText("Backup #1");
		await expect(backup.getByTestId("connection")).toHaveText("Live");

		// A visitor sees the counts, nobody's position, and a way to sign in.
		const visitor = await (await browser.newContext()).newPage();
		await visitor.goto(salePath);
		await expect(visitor.getByTestId("item-counts")).toHaveText("1 claim waiting · 0 offers");
		await expect(visitor.getByTestId("my-position")).toHaveCount(0);
		await expect(visitor.getByRole("link", { name: "Sign in to claim" })).toBeVisible();
		await visitor.context().close();
		await ann.context().close();
		await bob.context().close();
	});
});
