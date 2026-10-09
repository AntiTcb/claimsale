import { expect, test } from "./fixtures.ts";

test("home page introduces ClaimSale @critical", async ({ page, expectAccessible }) => {
	await page.goto("/");
	await expect(page).toHaveTitle(/ClaimSale/);
	await expect(page.getByRole("heading", { level: 1, name: "ClaimSale" })).toBeVisible();
	await expect(page.getByRole("contentinfo")).toContainText("not affiliated with");
	await expectAccessible();
});
