import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import InvoiceLines from "./InvoiceLines.svelte";
import ShippingMenuEditor from "./ShippingMenuEditor.svelte";

const invoice = {
	lines: [
		{ entryId: "e1", title: "Charizard ex", amountCents: 2500, refundOwed: false },
		{ entryId: "e2", title: "Pikachu promo", amountCents: 800, refundOwed: true },
	],
	subtotalCents: 2500,
	shippingCents: 550,
	adjustmentCents: 0,
	totalCents: 3050,
	shippingOptionLabel: "Ground Advantage",
	shippingOptionId: "ground",
};

describe("InvoiceLines", () => {
	it("lists the lines and totals, marking refund-owed lines", async () => {
		await render(InvoiceLines, { invoice });
		await expect.element(page.getByRole("table", { name: "Items and totals" })).toBeVisible();
		await expect.element(page.getByRole("cell", { name: "Charizard ex" })).toBeVisible();
		await expect.element(page.getByText("Refund owed")).toBeVisible();
		await expect.element(page.getByRole("rowheader", { name: "Shipping (Ground Advantage)" })).toBeVisible();
		await expect.element(page.getByTestId("invoice-total")).toHaveTextContent("$30.50");
	});

	it("says shipping is chosen at payment until the buyer picks it", async () => {
		await render(InvoiceLines, {
			invoice: {
				...invoice,
				shippingOptionId: null,
				shippingOptionLabel: null,
				shippingCents: 0,
				totalCents: 2500,
			},
		});
		await expect.element(page.getByText("Chosen when paying")).toBeVisible();
	});
});

describe("ShippingMenuEditor", () => {
	const options = [
		{ id: "pwe", label: "Envelope", price: "1.50", tracked: false },
		{ id: "ground", label: "Ground", price: "5.50", tracked: true },
	];

	it("renders each option as labelled form fields the page's form posts [SM-6-shipping-menu]", async () => {
		const screen = await render(ShippingMenuEditor, { options, tier: "free" });
		await expect.element(page.getByRole("group", { name: "Shipping options" })).toBeVisible();
		await expect.element(page.getByLabelText("Option 1 name")).toHaveValue("Envelope");
		await expect.element(page.getByLabelText("Price ($) for option 2")).toHaveValue("5.50");
		await expect.element(page.getByRole("checkbox", { name: "Tracked (option 2)" })).toBeChecked();
		await expect.element(page.getByText(/over \$20/)).toBeVisible();
		const tracked = screen.container.querySelectorAll<HTMLInputElement>('input[name="optionTracked"]');
		expect([...tracked].map((i) => i.value)).toEqual(["0", "1"]);
	});

	it("adds and removes options from the keyboard, moving focus sensibly [SM-6-shipping-menu]", async () => {
		await render(ShippingMenuEditor, { options, tier: "pro" });
		await expect.element(page.getByText(/over \$40/)).toBeVisible();
		await page.getByRole("button", { name: "Add an option" }).click();
		await expect.element(page.getByLabelText("Option 3 name")).toHaveFocus();
		await userEvent.keyboard("Local pickup");
		await expect.element(page.getByLabelText("Option 3 name")).toHaveValue("Local pickup");
		await page.getByRole("button", { name: "Remove option 1" }).click();
		await expect.element(page.getByLabelText("Option 1 name")).toHaveValue("Ground");
		await expect.element(page.getByLabelText("Option 2 name")).toHaveValue("Local pickup");
		await expect.element(page.getByRole("button", { name: "Add an option" })).toHaveFocus();
	});

	it("shows the server's errors next to their fields [SM-6-shipping-menu]", async () => {
		await render(ShippingMenuEditor, {
			options,
			tier: "free",
			errors: [
				{ row: 1, field: "price", message: "Shipping can be at most $100.00" },
				{ row: -1, field: "menu", message: "Offer at most 10 options" },
			],
		});
		await expect
			.element(page.getByLabelText("Price ($) for option 2"))
			.toHaveAttribute("aria-invalid", "true");
		await expect
			.element(page.getByLabelText("Price ($) for option 2"))
			.toHaveAccessibleDescription("Shipping can be at most $100.00");
		await expect.element(page.getByText("Offer at most 10 options")).toBeVisible();
	});
});
