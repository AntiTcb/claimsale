import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import ItemCard from "./ItemCard.svelte";
import SaleDetailsFields from "./SaleDetailsFields.svelte";
import SaleStatusBadge from "./SaleStatusBadge.svelte";
import WizardSteps from "./WizardSteps.svelte";

describe("WizardSteps", () => {
	it("marks the current step and links back to finished ones", async () => {
		await render(WizardSteps, { current: 2, saleId: "s1" });
		await expect.element(page.getByRole("navigation", { name: "New sale steps" })).toBeVisible();
		await expect.element(page.getByText("2. Terms")).toHaveAttribute("aria-current", "step");
		await expect.element(page.getByRole("link", { name: "1. Details" })).toHaveAttribute("href", "/sell/s1");
		await expect.element(page.getByRole("link", { name: "3. Items" })).not.toBeInTheDocument();
	});

	it("has no links before the draft exists", async () => {
		await render(WizardSteps, { current: 1 });
		await expect.element(page.getByText("1. Details")).toHaveAttribute("aria-current", "step");
		await expect.element(page.getByRole("link")).not.toBeInTheDocument();
	});
});

describe("SaleStatusBadge", () => {
	it("names the status, with the go-live time for scheduled sales", async () => {
		const liveAt = Date.UTC(2026, 10, 20, 1);
		await render(SaleStatusBadge, { status: "scheduled", liveAt });
		await expect.element(page.getByText(/^Scheduled/)).toBeVisible();
		const time =
			page
				.getByText(/2026|Nov/)
				.element()
				.closest("time") ?? page.getByRole("time").element();
		expect(time?.getAttribute("datetime")).toBe(new Date(liveAt).toISOString());
	});

	it("shows plain labels for other statuses", async () => {
		await render(SaleStatusBadge, { status: "draft" });
		await expect.element(page.getByText("Draft")).toBeVisible();
	});
});

describe("ItemCard", () => {
	const props = {
		href: "/s/sale/i/1",
		title: "Blue-Eyes White Dragon",
		priceCents: 4050,
		quantity: 3,
		gameId: "yugioh",
		kind: "single",
		condition: "LP",
		photoUrl: "/api/images/p1",
		state: "available" as const,
	};

	it("links to the item with its price, game, kind and condition", async () => {
		await render(ItemCard, props);
		const link = page.getByRole("link", { name: /Blue-Eyes White Dragon/ });
		await expect.element(link).toHaveAttribute("href", "/s/sale/i/1");
		await expect.element(page.getByText("$40.50")).toBeVisible();
		await expect.element(page.getByText("Yu-Gi-Oh! · Single · Lightly Played")).toBeVisible();
		await expect.element(page.getByText("3 available")).toBeVisible();
	});

	it("says when there is no photo and when the item is sold out", async () => {
		await render(ItemCard, { ...props, photoUrl: null, quantity: 1, condition: null, state: "sold_out" });
		await expect.element(page.getByText("No photo yet")).toBeVisible();
		await expect.element(page.getByText("Sold out")).toBeVisible();
		await expect.element(page.getByText("Yu-Gi-Oh! · Single")).toBeVisible();
	});
});

describe("SaleDetailsFields", () => {
	const values = { title: "Weekend dump", description: "", visibility: "unlisted", allowlist: "" };

	it("offers private sales only to Pro sellers (D31)", async () => {
		await render(SaleDetailsFields, { values, canUsePrivate: false });
		await expect.element(page.getByLabelText("Title")).toHaveValue("Weekend dump");
		await expect.element(page.getByRole("radio", { name: /Unlisted/ })).toBeChecked();
		await expect.element(page.getByRole("radio", { name: /Private/ })).toBeDisabled();
		await expect.element(page.getByLabelText("Sale password")).not.toBeInTheDocument();
	});

	it("shows the password and invite list once private is chosen", async () => {
		await render(SaleDetailsFields, { values, canUsePrivate: true, hasPassword: true });
		await userEvent.click(page.getByRole("radio", { name: /Private/ }));
		await expect
			.element(page.getByLabelText("Sale password"))
			.toHaveAccessibleDescription(/Leave blank to keep/);
		await expect.element(page.getByLabelText("Invite list (optional)")).toBeVisible();
	});

	it("links field errors to their inputs", async () => {
		await render(SaleDetailsFields, {
			values: { ...values, visibility: "private" },
			canUsePrivate: true,
			errors: { title: "Enter a title", password: "Set a password, invite at least one email, or both" },
		});
		await expect.element(page.getByLabelText("Title")).toHaveAccessibleDescription("Enter a title");
		await expect.element(page.getByLabelText("Sale password")).toHaveAttribute("aria-invalid", "true");
	});
});
