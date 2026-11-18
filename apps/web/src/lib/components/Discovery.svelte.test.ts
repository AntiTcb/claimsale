import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import CopyAsText from "./CopyAsText.svelte";
import ItemCard from "./ItemCard.svelte";
import ReportButton from "./ReportButton.svelte";
import SaleCard from "./SaleCard.svelte";
import SearchBox from "./SearchBox.svelte";

describe("SaleCard", () => {
	it("links to the sale with its seller, item count and status", async () => {
		await render(SaleCard, {
			slug: "weekend-ygo",
			title: "Weekend YGO",
			status: "live",
			liveAt: null,
			sellerHandle: "misty",
			sellerName: "Misty",
			itemCount: 1,
			imageId: "img-1",
		});
		const link = page.getByRole("link", { name: /Weekend YGO/ });
		await expect.element(link).toHaveAttribute("href", "/s/weekend-ygo");
		await expect.element(page.getByText("@misty · 1 item")).toBeVisible();
		await expect.element(page.getByText("Live")).toBeVisible();
	});
});

describe("ItemCard on discovery pages", () => {
	it("says where the item is listed", async () => {
		await render(ItemCard, {
			href: "/s/x/i/1",
			title: "Charizard ex",
			priceCents: 4500,
			quantity: 1,
			gameId: "pokemon",
			kind: "single",
			condition: "NM",
			photoUrl: null,
			state: "available",
			listedIn: "Weekend sale · @misty",
		});
		await expect.element(page.getByText("Weekend sale · @misty")).toBeVisible();
		await expect.element(page.getByText("$45.00")).toBeVisible();
	});
});

describe("SearchBox", () => {
	it("is a GET form to /search, keeping the game when given", async () => {
		const { container } = await render(SearchBox, { value: "pikachu", game: "pokemon" });
		await expect
			.element(page.getByRole("searchbox", { name: "Search cards and sales" }))
			.toHaveValue("pikachu");
		const form = container.querySelector("form")!;
		expect([form.getAttribute("method"), form.getAttribute("action")]).toEqual(["GET", "/search"]);
		expect(container.querySelector<HTMLInputElement>('input[name="game"]')?.value).toBe("pokemon");
	});
});

describe("CopyAsText", () => {
	const props = {
		title: "Weekend YGO",
		url: "https://claimsale.test/s/weekend-ygo",
		liveAt: null,
		closesAt: null,
		items: [
			{ title: "Blue-Eyes", priceCents: 4000, quantity: 1, condition: "LP", state: "available" },
			{ title: "Gone", priceCents: 100, quantity: 1, condition: null, state: "withdrawn" },
		],
	};

	it("[DISC-copy-text] copies the sale as text and shows it", async () => {
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		await render(CopyAsText, props);
		await userEvent.click(page.getByRole("button", { name: "Copy as text" }));
		const expected =
			"Weekend YGO\n\n1. Blue-Eyes · LP · $40.00\n\nClaim here: https://claimsale.test/s/weekend-ygo";
		await expect.element(page.getByRole("status")).toHaveTextContent("Copied.");
		expect(writeText).toHaveBeenCalledWith(expected);
		await expect.element(page.getByLabelText("Sale as text")).toHaveValue(expected);
		writeText.mockRestore();
	});

	it("falls back to the text box when the clipboard is refused", async () => {
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
		await render(CopyAsText, { ...props, liveAt: Date.UTC(2026, 10, 20, 1) });
		await userEvent.click(page.getByRole("button", { name: "Copy as text" }));
		await expect
			.element(page.getByRole("status"))
			.toHaveTextContent("Couldn't reach the clipboard; select the text below and copy it.");
		const box = page.getByLabelText("Sale as text");
		await expect.element(box).toBeVisible();
		const el = box.element();
		expect(el instanceof HTMLTextAreaElement ? el.value : "").toMatch(/^Weekend YGO\nGoes live /);
		writeText.mockRestore();
	});
});

describe("ReportButton", () => {
	it("sends signed-out visitors to sign in", async () => {
		await render(ReportButton, { kind: "sale", what: "this sale", signedIn: false, next: "/s/x" });
		await expect
			.element(page.getByRole("link", { name: "Report this sale" }))
			.toHaveAttribute("href", "/login?next=%2Fs%2Fx");
	});

	it("posts a reason to the page's report action, with reasons that fit the target", async () => {
		const { container } = await render(ReportButton, {
			kind: "user",
			what: "@misty",
			signedIn: true,
			next: "/u/misty",
		});
		await userEvent.click(page.getByText("Report @misty"));
		const form = container.querySelector("form")!;
		expect(form.getAttribute("action")).toBe("?/report");
		const options = [...container.querySelectorAll("option")].map((o) => o.value);
		expect(options).toContain("harassment");
		expect(options).not.toContain("stolen_photo");
	});

	it("stays open to thank the reporter (regression: the box closed and hid it)", async () => {
		await render(ReportButton, {
			kind: "sale",
			what: "this sale",
			signedIn: true,
			next: "/s/x",
			result: { reported: true },
		});
		await expect.element(page.getByRole("status")).toHaveTextContent("Thanks. An admin will look at it.");
	});

	it("shows the result of the report", async () => {
		await render(ReportButton, {
			kind: "sale",
			what: "this sale",
			signedIn: true,
			next: "/s/x",
			result: { reportError: "You've already reported this; an admin will look at it" },
		});
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("You've already reported this; an admin will look at it");
	});
});
