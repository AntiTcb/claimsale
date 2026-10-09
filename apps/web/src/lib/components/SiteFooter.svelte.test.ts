import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import SiteFooter from "./SiteFooter.svelte";

describe("SiteFooter", () => {
	it("shows the copyright year", async () => {
		await render(SiteFooter, { year: 2026 });
		await expect.element(page.getByText("© 2026 ClaimSale")).toBeVisible();
	});

	it("defaults to the current year", async () => {
		await render(SiteFooter);
		await expect.element(page.getByText(`© ${new Date().getFullYear()} ClaimSale`)).toBeVisible();
	});

	it("states that ClaimSale isn't affiliated with TCG publishers", async () => {
		await render(SiteFooter);
		const disclaimer = page.getByText(/not affiliated with, endorsed by, or sponsored by/);
		await expect.element(disclaimer).toBeVisible();
		// Compare what a reader sees: collapse source whitespace the way the browser renders it.
		const text = (disclaimer.element().textContent ?? "").replace(/\s+/g, " ");
		for (const publisher of ["Konami", "The Pokémon Company", "Wizards of the Coast", "Riot Games"]) {
			expect(text).toContain(publisher);
		}
	});

	it("is exposed as the page's contentinfo landmark", async () => {
		await render(SiteFooter);
		await expect.element(page.getByRole("contentinfo")).toBeInTheDocument();
	});
});
