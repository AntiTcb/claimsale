import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import SellerRequirements from "./SellerRequirements.svelte";

describe("SellerRequirements", () => {
	it("[AUTH-seller-requirements] lists each requirement with what to do about the missing ones", async () => {
		await render(SellerRequirements, { blockers: ["email", "phone"], pro: false });
		await expect.element(page.getByRole("heading", { name: "Before you can sell" })).toBeVisible();
		await expect.element(page.getByText("You're 18 or older: done")).toBeInTheDocument();
		await expect.element(page.getByText("Verified email: missing")).toBeInTheDocument();
		await expect.element(page.getByText("Verified mobile number: missing")).toBeInTheDocument();
		const links = page.getByRole("link", { name: "Go to settings" });
		expect(links.elements().map((a) => a.getAttribute("href"))).toEqual([
			"/me/settings",
			"/me/settings#phone",
		]);
	});

	it("[AUTH-seller-requirements] leaves the phone out for Pro sellers", async () => {
		await render(SellerRequirements, { blockers: [], pro: true });
		await expect.element(page.getByRole("heading", { name: "You're ready to sell" })).toBeVisible();
		await expect.element(page.getByText(/Verified mobile number/)).not.toBeInTheDocument();
		await expect.element(page.getByText("Pro sellers don't need to verify a phone.")).toBeVisible();
	});

	it("explains the age requirement without a settings link", async () => {
		await render(SellerRequirements, { blockers: ["age"], pro: false });
		await expect.element(page.getByText(/Selling is for adults/)).toBeVisible();
		await expect.element(page.getByRole("link", { name: "Go to settings" })).not.toBeInTheDocument();
	});
});
