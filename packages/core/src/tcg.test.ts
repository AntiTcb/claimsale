import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AttributeValue, ItemKind } from "./attributes.ts";
import { MARKET_PERCENT_PRESETS, priceFromMarketPercent } from "./money.ts";
import {
	applyBulkPricePreview,
	applyCatalogAutofill,
	AUTOFILL_KEYS,
	buyerFacing,
	listingLabels,
	listingPolicyViolations,
	marketHint,
	previewBulkMarketPrice,
	REPACK_LABEL,
	type CatalogProduct,
} from "./tcg.ts";
import { requiresTrackedShipping, shippingOptionsFor, trackingRequiredFor } from "./invoice.ts";
import { expectOk, expectRejected, makeInvoice, SHIPPING_MENU } from "./testing.ts";

const listing = (
	kind: ItemKind,
	title: string,
	attributes: Record<string, AttributeValue> = {},
	description = "",
) => ({
	kind,
	title,
	description,
	attributes,
});
const codes = (l: ReturnType<typeof listing>) => listingPolicyViolations(l).map((v) => v.code);

describe("listing policy [TCG-no-code-cards]", () => {
	it("rejects digital code cards however they're described [TCG-no-code-cards]", () => {
		expect(codes(listing("single", "PTCGL Code Card x10"))).toEqual(["code_card"]);
		expect(codes(listing("lot", "50 TCG Live codes"))).toEqual(["code_card"]);
		expect(codes(listing("accessory", "MTG Arena code - Foundations"))).toEqual(["code_card"]);
		expect(codes(listing("single", "Redeemable code for PTCGL", {}, ""))).toEqual(["code_card"]);
		expect(
			codes(listing("sealed", "Promo", { name: "Scarlet & Violet Code Card", product_type: "Code Card" })),
		).toEqual(["code_card"]);
	});

	it("allows sealed product that merely includes a code card, and card names with 'Code' [TCG-no-code-cards]", () => {
		expect(
			codes(listing("sealed", "Elite Trainer Box", { name: "Obsidian Flames ETB" }, "Code card included")),
		).toEqual([]);
		expect(codes(listing("single", "Decode Talker", { name: "Decode Talker" }))).toEqual([]);
		expect(codes(listing("single", "Code of the Duelist booster pull", {}))).toEqual([]);
	});

	it("needs the altered flag when a single says it's altered [TCG-no-code-cards]", () => {
		expect(codes(listing("single", "Altered art Sol Ring"))).toEqual(["altered_unflagged"]);
		expect(codes(listing("single", "Altered art Sol Ring", { altered: true }))).toEqual([]);
		expect(listingLabels("single", { altered: true })).toEqual(["Altered"]);
	});

	it("needs the repack flag (and shows the label) for repacks [TCG-no-code-cards]", () => {
		expect(codes(listing("sealed", "Mystery repack box"))).toEqual(["repack_unflagged"]);
		expect(codes(listing("sealed", "Box", {}, "Not factory sealed"))).toEqual(["repack_unflagged"]);
		expect(codes(listing("sealed", "Mystery repack box", { repack: true }))).toEqual([]);
		expect(listingLabels("sealed", { repack: true })).toEqual([REPACK_LABEL]);
	});
});

describe("tracked shipping [TCG-tracked-graded-sealed]", () => {
	it("graded singles and sealed product always need tracking [TCG-tracked-graded-sealed]", () => {
		expect(requiresTrackedShipping("graded")).toBe(true);
		expect(requiresTrackedShipping("sealed")).toBe(true);
		expect(requiresTrackedShipping("single")).toBe(false);
		expect(requiresTrackedShipping("accessory")).toBe(false);
		expect(requiresTrackedShipping("lot")).toBe(false);
	});

	it("hides untracked options below the threshold when a graded or sealed item is on the invoice [TCG-tracked-graded-sealed]", () => {
		// $5 subtotal is well under the free threshold, so a raw single may go PWE.
		expect(shippingOptionsFor(SHIPPING_MENU, 500, "free", ["single"]).map((o) => o.id)).toEqual([
			"pwe",
			"ground",
		]);
		expect(shippingOptionsFor(SHIPPING_MENU, 500, "free", ["single", "graded"]).map((o) => o.id)).toEqual([
			"ground",
		]);
		expect(shippingOptionsFor(SHIPPING_MENU, 500, "pro", ["sealed"]).map((o) => o.id)).toEqual(["ground"]);
	});

	it("requires a tracking number to ship them [TCG-tracked-graded-sealed]", () => {
		const cheap = makeInvoice({
			lines: [{ entryId: "e1", description: "Slab", amountCents: 500, refundOwed: false }],
		});
		expect(trackingRequiredFor(cheap, ["single"])).toBe(false);
		expect(trackingRequiredFor(cheap, ["graded"])).toBe(true);
	});
});

const product: CatalogProduct = {
	tcgplayerProductId: 509876,
	game: "pokemon",
	kind: "single",
	name: "Charizard ex",
	setCode: "OBF",
	setName: "Obsidian Flames",
	number: "125/197",
	rarity: "Double Rare",
	productType: null,
};

describe("catalog autofill [TCG-autofill-only]", () => {
	const draft: {
		game: string | null;
		kind: ItemKind;
		title: string;
		priceCents: number;
		quantity: number;
		attributes: Record<string, AttributeValue>;
	} = {
		game: null,
		kind: "single",
		title: "My Charizard",
		priceCents: 1500,
		quantity: 2,
		attributes: { condition: "LP", finish: "holo", language: "ja", name: "Old name", number: "1/1" },
	};

	it("picking a product sets only catalog fields and never touches seller fields [TCG-autofill-only]", () => {
		const filled = expectOk(applyCatalogAutofill(draft, product, "replace"));
		expect(filled.game).toBe("pokemon");
		expect(filled.attributes).toEqual({
			condition: "LP",
			finish: "holo",
			language: "ja",
			name: "Charizard ex",
			set_code: "OBF",
			set_name: "Obsidian Flames",
			number: "125/197",
			rarity: "Double Rare",
			tcgplayer_product_id: 509876,
		});
		expect(filled.title).toBe("My Charizard");
		expect(filled.priceCents).toBe(1500);
		expect(filled.quantity).toBe(2);
	});

	it("an import match only fills blanks, so the seller's file wins [TCG-autofill-only]", () => {
		const filled = expectOk(applyCatalogAutofill({ ...draft, game: "pokemon" }, product, "fill-blanks"));
		expect(filled.attributes["name"]).toBe("Old name");
		expect(filled.attributes["number"]).toBe("1/1");
		expect(filled.attributes["set_code"]).toBe("OBF");
	});

	it("rejects accessories, lots, the wrong product kind and another game [TCG-autofill-only]", () => {
		expect(expectRejected(applyCatalogAutofill({ ...draft, kind: "lot" }, product, "replace"))).toBe(
			"not_catalogued",
		);
		expect(expectRejected(applyCatalogAutofill({ ...draft, kind: "sealed" }, product, "replace"))).toBe(
			"kind_mismatch",
		);
		expect(expectRejected(applyCatalogAutofill({ ...draft, game: "mtg" }, product, "fill-blanks"))).toBe(
			"game_mismatch",
		);
	});

	const box: CatalogProduct = {
		...product,
		tcgplayerProductId: 501,
		kind: "sealed",
		name: "Obsidian Flames Booster Box",
		number: "N/A",
		rarity: "None",
		productType: "Booster Box",
	};

	it("fills a sealed item's product type but never a number or rarity [TCG-autofill-only]", () => {
		const sealed = { ...draft, kind: "sealed" as const, attributes: { repack: false, number: "stale" } };
		expect(expectOk(applyCatalogAutofill(sealed, box, "replace")).attributes).toEqual({
			repack: false,
			name: "Obsidian Flames Booster Box",
			set_code: "OBF",
			set_name: "Obsidian Flames",
			product_type: "Booster Box",
			tcgplayer_product_id: 501,
		});
	});

	it("takes the product's game when an import row has none [TCG-autofill-only]", () => {
		const row = { ...draft, kind: "sealed" as const, attributes: {} };
		expect(expectOk(applyCatalogAutofill(row, box, "fill-blanks")).game).toBe("pokemon");
	});

	it("only ever changes the game and the autofill keys (property) [TCG-autofill-only]", () => {
		const value = fc.oneof(fc.string(), fc.integer(), fc.boolean());
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.constantFrom(
						"condition",
						"finish",
						"language",
						"altered",
						"name",
						"number",
						"rarity",
						"edition",
					),
					value,
				),
				fc.constantFrom<"replace" | "fill-blanks">("replace", "fill-blanks"),
				fc.constantFrom<"single" | "graded">("single", "graded"),
				(attributes, mode, kind) => {
					const before = { game: "pokemon", kind, attributes, priceCents: 999, title: "t" };
					const after = expectOk(applyCatalogAutofill(before, product, mode));
					const allowed = new Set<string>(AUTOFILL_KEYS);
					const sellerOnly = (record: Record<string, unknown>) =>
						Object.fromEntries(Object.entries(record).filter(([key]) => !allowed.has(key)));
					expect(sellerOnly(after.attributes)).toEqual(sellerOnly(attributes));
					expect(after.priceCents).toBe(999);
					expect(after.title).toBe("t");
				},
			),
		);
	});
});

describe("market price aid [TCG-market-placeholder]", () => {
	const base = {
		viewerId: "seller_1",
		sellerId: "seller_1",
		kind: "single" as const,
		tcgplayerProductId: 509876,
		quote: { marketCents: 1240, asOf: Date.UTC(2026, 9, 8, 6) },
	};

	it("shows the seller a placeholder and % buttons, highlighting their default [TCG-market-placeholder]", () => {
		const hint = marketHint({ ...base, defaultPercent: 80 })!;
		expect(hint.placeholder).toBe("Market $12.40 · updated Oct 8");
		expect(hint.presets.map((p) => p.percent)).toEqual([...MARKET_PERCENT_PRESETS]);
		expect(hint.presets.find((p) => p.percent === 80)?.priceCents).toBe(975);
		expect(hint.highlightedPercent).toBe(80);
		expect(marketHint({ ...base, defaultPercent: 77 })!.highlightedPercent).toBeNull();
	});

	it("never shows a market price to anyone but the item's seller [TCG-market-placeholder]", () => {
		expect(marketHint({ ...base, viewerId: "buyer_1" })).toBeNull();
		expect(marketHint({ ...base, viewerId: null })).toBeNull();
	});

	it("has no hint for graded, accessory, lot or uncatalogued items [TCG-market-placeholder]", () => {
		for (const kind of ["graded", "accessory", "lot"] as const)
			expect(marketHint({ ...base, kind })).toBeNull();
		expect(marketHint({ ...base, tcgplayerProductId: null })).toBeNull();
		expect(marketHint({ ...base, quote: null })).toBeNull();
	});

	it("highlights no button when the seller has no default % [TCG-market-placeholder]", () => {
		const hint = marketHint({ ...base, kind: "sealed", quote: { marketCents: 15_000, asOf: 0 } });
		expect(hint?.highlightedPercent).toBeNull();
		expect(hint?.placeholder).toBe("Market $150.00 · updated Jan 1");
	});

	it("strips market data from buyer-facing values at any depth [TCG-market-placeholder]", () => {
		const view = buyerFacing({
			id: "item_1",
			priceCents: 975,
			marketCents: 1240,
			market: { cents: 1240 },
			attributes: { condition: "NM", tcgMarketPrice: "12.40" },
			related: [{ id: "item_2", MarketHint: "x" }],
		});
		expect(view).toEqual({
			id: "item_1",
			priceCents: 975,
			attributes: { condition: "NM" },
			related: [{ id: "item_2" }],
		});
	});

	it("no buyer projection ever contains a market key (property) [TCG-market-placeholder]", () => {
		const key = fc.oneof(
			fc.string(),
			fc.constantFrom("market", "marketCents", "tcgMarketPrice", "MARKET_AS_OF"),
		);
		const tree = fc.letrec<{ node: unknown }>((tie) => ({
			node: fc.oneof(
				{ depthSize: "small" },
				fc.integer(),
				fc.string(),
				fc.array(tie("node"), { maxLength: 3 }),
				fc.dictionary(key, tie("node"), { maxKeys: 4 }),
			),
		})).node;
		fc.assert(
			fc.property(tree, (value) => {
				const keys: string[] = [];
				const walk = (v: unknown) => {
					if (Array.isArray(v)) v.forEach(walk);
					else if (v !== null && typeof v === "object") {
						for (const [k, inner] of Object.entries(v)) {
							keys.push(k);
							walk(inner);
						}
					}
				};
				walk(buyerFacing(value));
				expect(keys.filter((k) => /market/i.test(k))).toEqual([]);
			}),
		);
	});
});

describe("bulk N% of market [TCG-market-pct]", () => {
	const items = [
		{ itemId: "a", priceCents: null, selected: false, marketCents: 1240 },
		{ itemId: "b", priceCents: 500, selected: true, marketCents: 1000 },
		{ itemId: "c", priceCents: null, selected: true, marketCents: null },
		{ itemId: "d", priceCents: 800, selected: true, marketCents: 1000 },
	];

	it("previews blank prices only, then applies exactly the preview [TCG-market-pct]", () => {
		const preview = previewBulkMarketPrice(items, 80, "blank");
		expect(preview.changes).toEqual([{ itemId: "a", fromCents: null, toCents: 975 }]);
		expect(preview.skipped).toEqual([{ itemId: "c", reason: "no_market" }]);
		expect([...applyBulkPricePreview(preview)]).toEqual([["a", 975]]);
	});

	it("previews selected items, skipping unchanged prices [TCG-market-pct]", () => {
		const preview = previewBulkMarketPrice(items, 80, "selected");
		expect(preview.changes).toEqual([{ itemId: "b", fromCents: 500, toCents: 800 }]);
		expect(preview.skipped).toEqual([
			{ itemId: "c", reason: "no_market" },
			{ itemId: "d", reason: "unchanged" },
		]);
	});

	it("every previewed price is the single-item rounding (property) [TCG-market-pct]", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(
					fc.record({
						itemId: fc.uuid(),
						priceCents: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: null }),
						selected: fc.boolean(),
						marketCents: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
					}),
					{ selector: (c) => c.itemId },
				),
				fc.constantFrom(...MARKET_PERCENT_PRESETS),
				fc.constantFrom<"selected" | "blank">("selected", "blank"),
				(candidates, pct, scope) => {
					const preview = previewBulkMarketPrice(candidates, pct, scope);
					for (const change of preview.changes) {
						const item = candidates.find((c) => c.itemId === change.itemId)!;
						expect(change.toCents).toBe(priceFromMarketPercent(item.marketCents!, pct));
					}
				},
			),
		);
	});
});
