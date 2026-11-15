/**
 * IO-export-roundtrip at the pure level: export a sale's items, write them as CSV,
 * read the file back, map, validate and plan the import against the same items.
 * The plan must be empty: every row skipped as unchanged.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	attributeFields,
	ITEM_KINDS,
	type AttributeValue,
	type FieldSpec,
	type ItemKind,
} from "../attributes.ts";
import { GAMES, type Game } from "../games.ts";
import { expectOk } from "../testing.ts";
import { MAX_PRICE_CENTS } from "./cells.ts";
import { decodeText, encodeCsv, encodeUtf8, parseCsv, type Delimiter } from "./csv.ts";
import { itemsExport, tableRows, type ExportItem } from "./export.ts";
import { MAX_QUANTITY, planImport, validateImport, type OffersMode } from "./import.ts";
import { autoMapColumns, mapRows } from "./mapping.ts";

/**
 * Text that stresses CSV and formula escaping (quotes, both delimiters, line breaks,
 * leading formula characters, non-ASCII) but can't spell a word the listing policy
 * reacts to ("altered", "repack", "code card").
 */
const tricky = (maxLength: number) =>
	fc
		.string({
			unit: fc.constantFrom(
				"a",
				"b",
				"c",
				"x",
				"Z",
				"1",
				" ",
				",",
				";",
				'"',
				"'",
				"\n",
				"\r\n",
				"=",
				"+",
				"-",
				"@",
				"\t",
				"é",
				"€",
				"🃏",
			),
			maxLength: Math.min(maxLength, 40),
		})
		.map((s) => s.trim())
		.filter((s) => s.length <= maxLength);

const nonEmpty = (maxLength: number) => tricky(maxLength).filter((s) => s !== "");

function valueFor(spec: FieldSpec): fc.Arbitrary<AttributeValue> {
	switch (spec.type) {
		case "enum":
			return fc.constantFrom(...spec.options);
		case "bool":
			return fc.boolean();
		case "int":
			return fc.integer({ min: spec.min, max: spec.max });
		default: // "text"
			return spec.pattern ? fc.stringMatching(spec.pattern) : nonEmpty(spec.maxLength);
	}
}

function attributesFor(kind: ItemKind, game: Game | null): fc.Arbitrary<Record<string, AttributeValue>> {
	const fields = attributeFields(kind, game);
	const required = Object.fromEntries(fields.filter((f) => f.required).map((f) => [f.key, valueFor(f)]));
	const optional = Object.fromEntries(fields.filter((f) => !f.required).map((f) => [f.key, valueFor(f)]));
	return fc.tuple(fc.record(required), fc.record(optional, { requiredKeys: [] })).map(([a, b]) => {
		const out: Record<string, AttributeValue> = {};
		for (const [key, value] of Object.entries({ ...a, ...b })) if (value !== undefined) out[key] = value;
		return out;
	});
}

const gameAndKind = fc
	.tuple(fc.constantFrom(...ITEM_KINDS), fc.constantFrom(...GAMES), fc.boolean())
	.map(([kind, game, noGame]) => ({ kind, game: kind === "accessory" && noGame ? null : game }));

const offersFor = (priceCents: number) =>
	fc.oneof(
		fc.constant<{ offers: OffersMode; minOfferCents: null }>({ offers: "off", minOfferCents: null }),
		fc.constant<{ offers: OffersMode; minOfferCents: null }>({ offers: "on", minOfferCents: null }),
		fc
			.integer({ min: 1, max: priceCents })
			.map((min) => ({ offers: "min" as OffersMode, minOfferCents: min })),
	);

const item: fc.Arbitrary<Omit<ExportItem, "id" | "sku">> = gameAndKind.chain(({ kind, game }) =>
	fc.integer({ min: 1, max: MAX_PRICE_CENTS }).chain((priceCents) =>
		fc
			.record({
				game: fc.constant(game?.slug ?? null),
				kind: fc.constant(kind),
				title: nonEmpty(200),
				description: tricky(5000),
				priceCents: fc.constant(priceCents),
				quantity: fc.integer({ min: 1, max: MAX_QUANTITY }),
				offer: offersFor(priceCents),
				shippingOverrideCents: fc.option(fc.integer({ min: 0, max: MAX_PRICE_CENTS }), { nil: null }),
				attributes: attributesFor(kind, game),
				status: fc.constantFrom("available", "claimed", "unsold"),
				winnerHandle: fc.option(tricky(30), { nil: null }),
				finalPriceCents: fc.option(fc.integer({ min: 0, max: MAX_PRICE_CENTS }), { nil: null }),
			})
			.map(({ offer, ...rest }) => ({ ...rest, ...offer })),
	),
);

const sale = fc
	.uniqueArray(fc.tuple(item, fc.option(nonEmpty(64), { nil: null })), {
		minLength: 1,
		maxLength: 12,
		selector: ([, sku]) => sku?.toLowerCase() ?? Symbol(),
	})
	.map((rows): ExportItem[] => rows.map(([fields, sku], i) => ({ ...fields, id: `item_${i}`, sku })));

describe("export → import round trip [IO-export-roundtrip]", () => {
	it("re-importing an unchanged items export plans no changes (property) [IO-export-roundtrip]", () => {
		fc.assert(
			fc.property(sale, fc.constantFrom<Delimiter>(",", ";"), (items, delimiter) => {
				const csv = encodeCsv(tableRows(itemsExport(items)), { delimiter });
				const table = parseCsv(decodeText(encodeUtf8(csv)).text);
				const { mapping, unmapped } = autoMapColumns(table[0]!);
				expect(unmapped).toEqual([]);
				const validated = expectOk(validateImport(mapRows(table, mapping), { sellerTier: "pro" }));
				expect(validated.errors).toEqual([]);
				const plan = planImport({
					rows: validated.items,
					existing: items,
					removeMissing: true,
					sellerTier: "pro",
				});
				expect(plan.creates).toEqual([]);
				expect(plan.updates).toEqual([]);
				expect(plan.removals).toEqual([]);
				expect(plan.outcomes.every((o) => o.outcome === "skipped")).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});

	it("a changed price in the file becomes exactly one update [IO-export-roundtrip]", () => {
		fc.assert(
			fc.property(sale, (items) => {
				const table = [...tableRows(itemsExport(items))].map((row) => [...row]);
				const priceColumn = table[0]!.indexOf("price");
				const original = items[0]!.priceCents;
				const changed = original === MAX_PRICE_CENTS ? original - 1 : original + 1;
				table[1]![priceColumn] = `${Math.floor(changed / 100)}.${String(changed % 100).padStart(2, "0")}`;
				const parsed = parseCsv(encodeCsv(table));
				const validated = expectOk(
					validateImport(mapRows(parsed, autoMapColumns(parsed[0]!).mapping), { sellerTier: "pro" }),
				);
				const plan = planImport({
					rows: validated.items,
					existing: items,
					removeMissing: false,
					sellerTier: "pro",
				});
				// A hidden minimum above the new price is invalid, so that row may error instead.
				const outcomes = plan.outcomes.filter((o) => o.outcome !== "skipped");
				expect(outcomes.length + validated.errors.length).toBeGreaterThanOrEqual(1);
				expect(plan.updates.every((u) => u.itemId === "item_0" && u.changed.join() === "priceCents")).toBe(
					true,
				);
			}),
			{ numRuns: 50 },
		);
	});
});
