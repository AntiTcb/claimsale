import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import SiteHeader from "./SiteHeader.svelte";

describe("SiteHeader", () => {
	it("offers sign-in and sign-up when signed out", async () => {
		await render(SiteHeader, { user: null });
		await expect.element(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
		await expect
			.element(page.getByRole("link", { name: "Create account" }))
			.toHaveAttribute("href", "/signup");
		await expect.element(page.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
	});

	it("shows the handle, settings and a sign-out form when signed in", async () => {
		await render(SiteHeader, { user: { handle: "ash", displayName: "Ash" } });
		await expect.element(page.getByRole("link", { name: "@ash" })).toHaveAttribute("href", "/u/ash");
		await expect
			.element(page.getByRole("link", { name: "Settings" }))
			.toHaveAttribute("href", "/me/settings");
		const signOut = page.getByRole("button", { name: "Sign out" });
		await expect.element(signOut).toBeVisible();
		expect(signOut.element().closest("form")?.getAttribute("action")).toBe("/logout");
		expect(signOut.element().closest("form")?.getAttribute("method")).toBe("POST");
	});

	it("leaves out the profile link until onboarding sets a handle", async () => {
		await render(SiteHeader, { user: { handle: null, displayName: "New" } });
		await expect.element(page.getByRole("link", { name: "Settings" })).toBeVisible();
		await expect.element(page.getByRole("link", { name: /^@/ })).not.toBeInTheDocument();
	});
});
