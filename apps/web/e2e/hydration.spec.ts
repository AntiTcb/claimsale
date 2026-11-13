import { expect, test } from "./fixtures.ts";

// Regression: typing into a form before the page hydrated was wiped when Svelte took
// over the server-rendered inputs (the sign-up form lost its display name). Holding
// back the app's JavaScript makes the race deterministic.
test("text typed before hydration survives it", async ({ page }) => {
	const { promise: held, resolve: release } = Promise.withResolvers<void>();
	await page.route("**/_app/immutable/**", async (route) => {
		await held;
		await route.continue();
	});

	// Module scripts hold back DOMContentLoaded, so wait for the server-rendered field instead.
	await page.goto("/signup", { waitUntil: "commit" });
	await page.getByLabel("Display name").fill("Typed Early");
	await page.getByLabel("Handle").fill("typed_early");
	release();
	await page.waitForLoadState("networkidle");
	// Hydration has run once the age radios react (the consent box appears).
	await page.getByLabel("13 to 17").check();
	await expect(page.getByLabel(/parent or guardian/)).toBeVisible();

	await expect(page.getByLabel("Display name")).toHaveValue("Typed Early");
	await expect(page.getByLabel("Handle")).toHaveValue("typed_early");
});
