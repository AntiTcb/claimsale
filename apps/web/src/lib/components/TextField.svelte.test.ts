import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import TextField from "./TextField.svelte";

describe("TextField", () => {
	it("labels the input and keeps its value", async () => {
		await render(TextField, { label: "Handle", name: "handle", value: "ash" });
		const input = page.getByLabelText("Handle");
		await expect.element(input).toHaveValue("ash");
		await expect.element(input).toHaveAttribute("id", "field-handle");
		await expect.element(input).toHaveAttribute("name", "handle");
		await expect.element(input).not.toHaveAttribute("aria-invalid");
	});

	it("links the hint and the error to the input", async () => {
		await render(TextField, {
			label: "Handle",
			name: "handle",
			hint: "Letters only",
			error: "That handle is taken",
		});
		const input = page.getByLabelText("Handle");
		await expect.element(input).toHaveAttribute("aria-invalid", "true");
		await expect.element(input).toHaveAccessibleDescription("That handle is taken Letters only");
	});

	it("takes an explicit id so two fields can share a name", async () => {
		await render(TextField, { label: "Email for the link", name: "email", id: "magic-email", type: "email" });
		await expect.element(page.getByLabelText("Email for the link")).toHaveAttribute("id", "magic-email");
	});

	it("can be typed into with the keyboard", async () => {
		await render(TextField, { label: "Display name", name: "displayName", value: null });
		const input = page.getByLabelText("Display name");
		await expect.element(input).toHaveValue("");
		await userEvent.click(input);
		await userEvent.keyboard("Ash");
		await expect.element(input).toHaveValue("Ash");
	});
});
