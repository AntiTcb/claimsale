import {
	codeFromSms,
	linkFromEmail,
	newIdentity,
	newPhone,
	outboxAvailable,
	signUp,
	smsCaptureAvailable,
} from "./auth-helpers.ts";
import { expect, test } from "./fixtures.ts";

// Auth slice 2 (D55, TECH_STACK S41): phone verification in capture mode and the
// seller requirements it unlocks.
test.describe("phone verification and seller requirements", () => {
	test("a new seller is blocked until email and phone are verified @critical", async ({
		page,
		request,
		expectAccessible,
	}) => {
		test.skip(!(await smsCaptureAvailable(request)), "Captured phone codes aren't readable here");
		test.skip(!(await outboxAvailable(request)), "Captured email isn't readable here");
		const who = newIdentity("ph");
		const phone = newPhone();
		await signUp(page, who);
		await expect(page).toHaveURL(/\/\?welcome=1$/);

		// The real /sell pages send an unready seller to the checklist, keeping where they were going.
		await page.goto("/sell/new");
		await expect(page).toHaveURL(/\/sell\/requirements\?next=%2Fsell%2Fnew$/);
		await expect(page.getByRole("heading", { name: "Before you can sell" })).toBeVisible();
		await expect(page.getByText("Verified email: missing")).toBeAttached();
		await expect(page.getByText("Verified mobile number: missing")).toBeAttached();
		await expect(page.getByRole("link", { name: "Continue" })).toHaveCount(0);
		await expectAccessible();

		await page.goto(await linkFromEmail(request, who.email, "Confirm your email"));

		await page.goto("/me/settings#phone");
		await page.getByLabel("Mobile number").fill(phone.typed);
		await page.getByRole("button", { name: "Text me a code" }).click();
		await expect(page.getByText(`We texted a 6-digit code to +1 ••• ${phone.last4}.`)).toBeVisible();
		await expectAccessible();

		await page.getByLabel("Code").fill("000000");
		await page.getByRole("button", { name: "Verify" }).click();
		await expect(page.getByText("That code isn't right. Check the text and try again.")).toBeVisible();

		await page.getByLabel("Code").fill(await codeFromSms(request, phone.e164));
		await page.getByRole("button", { name: "Verify" }).click();
		await expect(page.getByRole("status")).toHaveText("Your phone number is verified.");
		await expect(page.getByText(`Verified: +1 ••• ${phone.last4}`)).toBeVisible();
		// Never shown in full, even to its owner.
		await expect(page.locator("body")).not.toContainText(phone.e164.slice(2, 8));

		await page.goto("/sell/requirements?next=/sell/new");
		await expect(page.getByRole("heading", { name: "You're ready to sell" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/sell/new");
		await page.getByRole("link", { name: "Continue" }).click();
		await expect(page.getByRole("heading", { name: "New sale" })).toBeVisible();
	});

	test("one number can't verify a second account", async ({ page, browser, request }) => {
		test.skip(!(await smsCaptureAvailable(request)), "Captured phone codes aren't readable here");
		const phone = newPhone();
		await signUp(page, newIdentity("ph1"));
		await page.goto("/me/settings");
		await page.getByLabel("Mobile number").fill(phone.e164);
		await page.getByRole("button", { name: "Text me a code" }).click();
		await page.getByLabel("Code").fill(await codeFromSms(request, phone.e164));
		await page.getByRole("button", { name: "Verify" }).click();
		await expect(page.getByRole("status")).toHaveText("Your phone number is verified.");

		const other = await browser.newPage();
		await signUp(other, newIdentity("ph2"));
		await other.goto("/me/settings");
		await other.getByLabel("Mobile number").fill(phone.typed);
		await other.getByRole("button", { name: "Text me a code" }).click();
		await expect(other.getByText("This number is already verified on another account.")).toBeVisible();
		await other.close();
	});
});
