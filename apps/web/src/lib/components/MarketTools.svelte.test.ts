import { autoMapColumns, marketHint, type BulkPricePreview } from "@claimsale/core";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent, type Locator } from "vitest/browser";
import type { CatalogHit } from "#lib/market.ts";
import BulkMarketPrice from "./BulkMarketPrice.svelte";
import CatalogPicker from "./CatalogPicker.svelte";
import ColumnMapper from "./ColumnMapper.svelte";
import MarketPriceAid from "./MarketPriceAid.svelte";

/** The element's text with whitespace collapsed, or "" while it isn't rendered. */
const text = (locator: Locator): string => {
	try {
		return (locator.element().textContent ?? "").replace(/\s+/g, " ").trim();
	} catch {
		return "";
	}
};

const hint = marketHint({
	viewerId: "s",
	sellerId: "s",
	kind: "single",
	tcgplayerProductId: 1,
	quote: { marketCents: 1240, asOf: Date.UTC(2026, 9, 8) },
	defaultPercent: 80,
});

type Search = (query: string, game: string, kind: string) => Promise<CatalogHit[]>;

const hit = (id: number, name: string): CatalogHit => ({
	productId: id,
	tcgplayerProductId: 9000 + id,
	game: "pokemon",
	kind: "single",
	name,
	setName: "Obsidian Flames",
	setCode: "OBF",
	number: `${id}/197`,
	rarity: "Double Rare",
	productType: null,
});

describe("MarketPriceAid", () => {
	it("[TCG-market-placeholder] fills nothing until the seller clicks a % button", async () => {
		const onpick = vi.fn<(cents: number, percent: number) => void>();
		await render(MarketPriceAid, { hint, itemTitle: "Charizard", onpick });
		expect(onpick).not.toHaveBeenCalled();
		await expect
			.element(page.getByRole("group", { name: "Price of Charizard as a % of market" }))
			.toBeVisible();
		await expect.element(page.getByText(/Buyers never see it/)).toBeVisible();
		await userEvent.click(page.getByRole("button", { name: /to 80% of market, \$9\.75 \(your default\)/ }));
		expect(onpick).toHaveBeenCalledWith(975, 80);
	});

	it("[TCG-market-pct] offers 70–100 % with core's rounding", async () => {
		await render(MarketPriceAid, { hint, onpick: () => {} });
		for (const [percent, price] of [
			[70, "$8.50"],
			[75, "$9.25"],
			[85, "$10.50"],
			[90, "$11.00"],
			[100, "$12.25"],
		] as const) {
			await expect
				.element(page.getByRole("button", { name: `Set the price to ${percent}% of market, ${price}` }))
				.toBeVisible();
		}
	});

	it("renders nothing without a hint (graded, accessories, uncatalogued)", async () => {
		const screen = await render(MarketPriceAid, { hint: null, onpick: () => {} });
		expect(screen.container.querySelector("[data-testid=market-aid]")).toBeNull();
	});
});

describe("CatalogPicker", () => {
	it("[TCG-autofill-only] searches as the seller types and hands the picked product to the form", async () => {
		const search = vi.fn<Search>(async () => [hit(125, "Charizard ex"), hit(223, "Charizard ex")]);
		const onpick = vi.fn<(h: CatalogHit) => void>();
		await render(CatalogPicker, {
			saleId: "s1",
			game: "pokemon",
			kind: "graded",
			itemTitle: "Zard",
			search,
			onpick,
		});
		const box = page.getByRole("combobox", { name: "Find Zard in the catalog" });
		await userEvent.type(box, "chariz");
		// Typing is debounced; on a slow machine an earlier prefix may search first. Wait for the
		// search for the whole word (its results land before the next poll) before using them.
		await expect.poll(() => search.mock.lastCall).toEqual(["chariz", "pokemon", "graded"]);
		await expect.poll(() => text(page.getByRole("option").first())).toMatch(/^Charizard ex/);
		await expect.poll(() => text(page.getByRole("status"))).toMatch("2 catalog matches");
		await userEvent.keyboard("{ArrowDown}{Enter}");
		expect(onpick).toHaveBeenCalledWith(hit(223, "Charizard ex"));
		await expect.element(box).toHaveValue("");
		await expect.poll(() => text(page.getByRole("status"))).toMatch("Filled in Charizard ex");
	});

	it("says when nothing matches or search is down, and isn't offered for lots", async () => {
		let fail = false;
		const search = vi.fn<Search>(async () => {
			if (fail) throw new Error("down");
			return [];
		});
		const screen = await render(CatalogPicker, {
			saleId: "s1",
			game: "",
			kind: "single",
			search,
			onpick: () => {},
		});
		await userEvent.type(page.getByRole("combobox"), "zzz");
		await expect.poll(() => text(page.getByRole("status"))).toMatch("No catalog matches");
		fail = true;
		await userEvent.type(page.getByRole("combobox"), "z");
		await expect.poll(() => text(page.getByRole("status"))).toMatch(/unavailable/);
		await screen.rerender({ kind: "lot" });
		await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
	});
});

describe("BulkMarketPrice", () => {
	const candidates = [
		{ id: "a", label: "Charizard", priceCents: 1500, marketCents: 1240, selected: true },
		{ id: "b", label: "Pikachu", priceCents: 300, marketCents: null, selected: true },
		{ id: "c", label: "Mew", priceCents: 900, marketCents: 1000, selected: false },
	];

	it("[TCG-market-pct] previews every change before applying exactly that preview", async () => {
		const onapply = vi.fn<(p: BulkPricePreview) => void>();
		await render(BulkMarketPrice, { candidates, scope: "selected", defaultPercent: 80, onapply });
		await expect.element(page.getByText("Set 2 selected prices to a % of TCGplayer market")).toBeVisible();
		await userEvent.click(page.getByRole("button", { name: "90%" }));
		const preview = page.getByRole("region", { name: "Preview at 90% of market" });
		await expect.poll(() => text(preview)).toMatch(/Charizard: \$15\.00 → \$11\.00/);
		await expect.poll(() => text(preview)).toMatch(/1 without a market price stays as it is\./);
		expect(onapply).not.toHaveBeenCalled();
		await userEvent.click(page.getByRole("button", { name: "Apply to 1 item" }));
		expect(onapply).toHaveBeenCalledWith({
			percent: 90,
			changes: [{ itemId: "a", fromCents: 1500, toCents: 1100 }],
			skipped: [{ itemId: "b", reason: "no_market" }],
		});
	});

	it("can be cancelled, and covers blank prices on import", async () => {
		const onapply = vi.fn<(p: BulkPricePreview) => void>();
		const blank = [{ id: "3", label: "Row 3: Sol Ring", priceCents: null, marketCents: 200 }];
		await render(BulkMarketPrice, { candidates: blank, scope: "blank", defaultPercent: null, onapply });
		await userEvent.click(page.getByRole("button", { name: "100%" }));
		await expect
			.poll(() => text(page.getByRole("region", { name: "Preview at 100% of market" })))
			.toMatch(/Row 3: Sol Ring: no price → \$2\.00/);
		await userEvent.click(page.getByRole("button", { name: "Cancel" }));
		await expect.element(page.getByRole("region", { name: /^Preview/ })).not.toBeInTheDocument();
		expect(onapply).not.toHaveBeenCalled();
	});
});

describe("ColumnMapper", () => {
	it("maps each column to one field and says what's still missing", async () => {
		const headers = ["Card", "Qty", "Asking price", "Notes"];
		let mapping = autoMapColumns(headers).mapping;
		const onchange = vi.fn<(next: typeof mapping) => void>((next) => {
			mapping = next;
		});
		const screen = await render(ColumnMapper, {
			headers,
			sample: ["Sol Ring", "2", "1.50", ""],
			mapping,
			onchange,
		});
		await expect.poll(() => text(page.getByRole("status"))).toMatch(/^Not mapped yet: kind, title or name\./);
		await userEvent.selectOptions(page.getByRole("combobox", { name: "Import column Card as" }), "name");
		expect(onchange).toHaveBeenLastCalledWith(
			expect.objectContaining({ Card: "name", Qty: "quantity", "Asking price": "price" }),
		);
		await screen.rerender({ mapping });
		await userEvent.selectOptions(page.getByRole("combobox", { name: "Import column Notes as" }), "quantity");
		// A field takes one column: Qty lets go of it.
		expect(onchange).toHaveBeenLastCalledWith(expect.objectContaining({ Notes: "quantity", Qty: null }));
	});
});
