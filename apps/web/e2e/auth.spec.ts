import { linkFromEmail, newIdentity, outboxAvailable, signOut, signUp } from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";

// Auth (milestone 3): sign-up with handle and age, email verification, password and
// magic-link sign-in, password reset, onboarding, settings and public profiles.
test.describe("accounts", () => {
	test("sign up, verify the email, sign out and sign back in", async ({ page, request }) => {
		const who = newIdentity();
		await signUp(page, who);
		await expect(page).toHaveURL(/\/\?welcome=1$/);
		await expect(page.getByRole("link", { name: `@${who.handle}` })).toBeVisible();

		await page.goto("/me/settings");
		await expect(page.getByText("Not verified yet")).toBeVisible();
		test.skip(!(await outboxAvailable(request)), "Captured email isn't readable here");
		await page.goto(await linkFromEmail(request, who.email, "Confirm your email"));
		await page.goto("/me/settings");
		await expect(page.getByText("Verified.")).toBeVisible();

		await signOut(page);
		await page.goto("/login");
		await page.getByLabel("Email", { exact: true }).fill(who.email);
		await page.getByLabel("Password").fill(who.password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page.getByRole("link", { name: `@${who.handle}` })).toBeVisible();
	});

	test("the sign-up form explains what's wrong and is accessible", async ({ page, expectAccessible }) => {
		await page.goto("/signup");
		await expectAccessible();
		await page.getByLabel("Display name").fill("Kid");
		await page.getByLabel("Handle").fill("9bad");
		await page.getByLabel("Email").fill("not-an-email");
		await page.getByLabel("Password").fill("short");
		await page.getByLabel("13 to 17").check();
		await page.getByRole("button", { name: "Create account" }).click();
		await expect(
			page.getByText("Use letters, numbers and underscores, starting with a letter"),
		).toBeVisible();
		await expect(page.getByText("Enter a valid email address")).toBeVisible();
		await expect(page.getByText("Use 10–128 characters")).toBeVisible();
		await expect(page.getByText("Confirm that a parent or guardian said it's OK")).toBeVisible();
		await expect(page.getByLabel("Handle")).toHaveAttribute("aria-invalid", "true");
		await expectAccessible();

		await page.getByLabel("Under 13").check();
		await page.getByRole("button", { name: "Create account" }).click();
		await expect(page.getByText("You need to be at least 13 to use ClaimSale")).toBeVisible();
	});

	test("handles are unique, and a wrong password is refused", async ({ page, browser }) => {
		const first = newIdentity();
		await signUp(page, first);
		await expect(page.getByRole("link", { name: `@${first.handle}` })).toBeVisible();

		const other = await browser.newPage();
		const second = { ...newIdentity(), handle: first.handle.toUpperCase() };
		await signUp(other, second);
		await expect(other.getByText("That handle is taken")).toBeVisible();

		await other.goto("/login");
		await other.getByLabel("Email", { exact: true }).fill(first.email);
		await other.getByLabel("Password").fill("definitely-wrong-password");
		await other.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(other.getByRole("alert")).toHaveText("That email and password don't match.");
		await other.close();
	});

	test("a magic link signs in a new address, which finishes on onboarding", async ({
		page,
		request,
		expectAccessible,
	}) => {
		test.skip(!(await outboxAvailable(request)), "Captured email isn't readable here");
		const who = newIdentity("ml");
		await page.goto("/login");
		await expectAccessible();
		await page.getByLabel("Email for the link").fill(who.email);
		await page.getByRole("button", { name: "Email me a link" }).click();
		await expect(page.getByRole("status")).toContainText(who.email);

		await page.goto(await linkFromEmail(request, who.email, "sign-in link"));
		await expect(page).toHaveURL(/\/onboarding/);
		// Other pages send an unfinished account back here.
		await page.goto("/me/settings");
		await expect(page).toHaveURL(/\/onboarding\?next=%2Fme%2Fsettings/);

		await page.getByLabel("Display name").fill(who.displayName);
		await page.getByLabel("Handle").fill(who.handle);
		await page.getByLabel("13 to 17").check();
		await page.getByLabel(/parent or guardian/).check();
		await page.getByRole("button", { name: "Continue" }).click();
		await expect(page).toHaveURL(/\/me\/settings$/);
		// Signing in through the emailed link proves the address.
		await expect(page.getByText("Verified.")).toBeVisible();
	});

	test("a password reset link sets a new password and the old one stops working", async ({
		page,
		request,
	}) => {
		test.skip(!(await outboxAvailable(request)), "Captured email isn't readable here");
		const who = newIdentity("pw");
		await signUp(page, who);
		await signOut(page);

		await page.goto("/forgot-password");
		await page.getByLabel("Email").fill(who.email);
		await page.getByRole("button", { name: "Send the link" }).click();
		await expect(page.getByRole("status")).toContainText(who.email);

		await page.goto(await linkFromEmail(request, who.email, "Reset your"));
		await expect(page).toHaveURL(/\/reset-password\?token=/);
		const newPassword = `${who.password}-new`;
		await page.getByLabel("New password").fill(newPassword);
		await page.getByRole("button", { name: "Save password" }).click();
		await expect(page).toHaveURL(/\/login\?reset=1/);

		await page.getByLabel("Email", { exact: true }).fill(who.email);
		await page.getByLabel("Password").fill(who.password);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page.getByRole("alert")).toHaveText("That email and password don't match.");
		await page.getByLabel("Password").fill(newPassword);
		await page.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(page.getByRole("link", { name: `@${who.handle}` })).toBeVisible();
	});

	test("settings change the public profile", async ({ page, expectAccessible }) => {
		const who = newIdentity("pr");
		await signUp(page, who);
		await page.goto("/me/settings");
		await expectAccessible();

		await page.getByLabel("Facebook profile (optional)").fill("https://evil.example/not-facebook");
		await page.getByRole("button", { name: "Save profile" }).click();
		await expect(page.getByText("Enter a facebook.com profile link")).toBeVisible();

		const handle = `${who.handle.slice(0, 17)}_v2`;
		await page.getByLabel("Display name").fill("Renamed Tester");
		await page.getByLabel("Handle").fill(handle);
		await page.getByLabel("Facebook profile (optional)").fill("m.facebook.com/renamed.tester/");
		await page.getByRole("button", { name: "Save profile" }).click();
		await expect(page.getByRole("status")).toHaveText("Saved.");

		await page.goto(`/u/${handle}`);
		await expect(page.getByRole("heading", { name: "Renamed Tester" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Facebook profile" })).toHaveAttribute(
			"href",
			"https://www.facebook.com/renamed.tester",
		);
		await expectAccessible();
	});

	test("unknown profiles are a 404, and signed-out settings go to sign-in", async ({ page }) => {
		const res = await page.goto("/u/nobody_has_this_handle");
		expect(res?.status()).toBe(404);
		await page.goto("/me/settings");
		await expect(page).toHaveURL(/\/login\?next=%2Fme%2Fsettings/);
	});
});
