import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import PhoneVerification from "./PhoneVerification.svelte";

const formOf = (button: string) =>
	page.getByRole("button", { name: button }).element().closest("form")?.getAttribute("action");

describe("PhoneVerification", () => {
	it("asks for a number when none is verified", async () => {
		await render(PhoneVerification, { verified: null, pending: null, available: true });
		await expect.element(page.getByText(/No verified number yet/)).toBeVisible();
		await expect.element(page.getByLabelText("Mobile number")).toHaveAttribute("type", "tel");
		await expect.element(page.getByLabelText("Mobile number")).toHaveAttribute("autocomplete", "tel");
		expect(formOf("Text me a code")).toBe("?/phoneStart");
	});

	it("asks for the code once one was sent, with a way back", async () => {
		await render(PhoneVerification, { verified: null, pending: "+1 ••• 0123", available: true });
		await expect.element(page.getByText("+1 ••• 0123")).toBeVisible();
		await expect.element(page.getByLabelText("Code")).toHaveAttribute("autocomplete", "one-time-code");
		expect(formOf("Verify")).toBe("?/phoneCheck");
		expect(formOf("Use a different number")).toBe("?/phoneCancel");
	});

	it("[AUTH-phone-e164] shows the verified number only masked, and offers to change it", async () => {
		await render(PhoneVerification, {
			verified: "+1 ••• 0123",
			pending: null,
			available: true,
			status: "Your phone number is verified.",
		});
		await expect.element(page.getByText("Verified: +1 ••• 0123")).toBeVisible();
		await expect.element(page.getByRole("status")).toHaveTextContent("Your phone number is verified.");
		await expect.element(page.getByLabelText("New mobile number")).toBeVisible();
	});

	it("shows field and form errors", async () => {
		await render(PhoneVerification, {
			verified: null,
			pending: null,
			available: true,
			phoneValue: "123",
			errors: { phone: "Include your country code", form: "Too many codes." },
		});
		await expect.element(page.getByLabelText("Mobile number")).toHaveAttribute("aria-invalid", "true");
		await expect.element(page.getByText("Include your country code")).toBeVisible();
		await expect.element(page.getByRole("alert")).toHaveTextContent("Too many codes.");
	});

	it("says so when phone verification is unavailable here", async () => {
		await render(PhoneVerification, { verified: null, pending: null, available: false });
		await expect.element(page.getByText(/isn't available right now/)).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Text me a code" })).not.toBeInTheDocument();
	});
});
