import { describe, expect, it } from "vitest";
import { ITEM_KINDS } from "../attributes.ts";
import { GAMES } from "../games.ts";
import { FREE_ITEM_CAP } from "../plans.ts";
import type { SaleStatus } from "../sale.ts";
import { expectOk, expectRejected } from "../testing.ts";
import { templateRows } from "./columns.ts";
import {
	checkImportTarget,
	MAX_IMPORT_ROWS,
	planImport,
	validateImport,
	validateImportRow,
	type ExistingItem,
	type ImportedItem,
	type MappedRow,
} from "./import.ts";

const free = { sellerTier: "free" as const };
const pro = { sellerTier: "pro" as const };

const single = (overrides: Record<string, string> = {}) => ({
	game: "pokemon",
	kind: "single",
	name: "Charizard ex",
	condition: "NM",
	price: "12.40",
	...overrides,
});

const issues = (result: ReturnType<typeof validateImportRow>) => (result.ok ? [] : result.error);
const fields = (result: ReturnType<typeof validateImportRow>) =>
	issues(result)
		.map((i) => i.field)
		.toSorted();

describe("row validation [IO-import-validate]", () => {
	it("turns a valid row into an item, defaulting title, quantity and offers [IO-import-validate]", () => {
		const item = expectOk(validateImportRow(single({ sku: "CHZ-1", photos: "a.jpg; b.jpg;" }), free));
		expect(item).toMatchObject({
			sku: "CHZ-1",
			game: "pokemon",
			kind: "single",
			title: "Charizard ex",
			priceCents: 1240,
			quantity: 1,
			offers: "off",
			minOfferCents: null,
			photos: ["a.jpg", "b.jpg"],
			attributes: { name: "Charizard ex", condition: "NM" },
		});
	});

	it("reports every problem in a row, keyed by column [IO-import-validate]", () => {
		const result = validateImportRow(
			{
				game: "pokemon",
				kind: "single",
				price: "abc",
				quantity: "0",
				offers: "maybe",
				condition: "Mint-ish",
			},
			free,
		);
		expect(fields(result)).toEqual(["condition", "name", "offers", "price", "quantity", "title"]);
	});

	it("rejects unknown games and kinds, and requires a game except for accessories [IO-import-validate]", () => {
		expect(fields(validateImportRow(single({ game: "Hearthstone" }), free))).toContain("game");
		expect(fields(validateImportRow(single({ kind: "figure" }), free))).toEqual(["kind"]);
		expect(fields(validateImportRow(single({ game: "" }), free))).toEqual(["game"]);
		const accessory = expectOk(
			validateImportRow(
				{
					kind: "Accessory",
					title: "Dragon playmat",
					price: "20",
					accessory_type: "playmat",
					condition: "new",
				},
				free,
			),
		);
		expect(accessory.game).toBeNull();
	});

	it("only lets Pro sellers set a hidden minimum offer, at most the price [IO-import-validate]", () => {
		expect(fields(validateImportRow(single({ offers: "min", min_offer: "10" }), free))).toEqual(["offers"]);
		expect(expectOk(validateImportRow(single({ offers: "min", min_offer: "10" }), pro)).minOfferCents).toBe(
			1000,
		);
		expect(fields(validateImportRow(single({ offers: "min", min_offer: "20" }), pro))).toEqual(["min_offer"]);
		expect(fields(validateImportRow(single({ offers: "on", min_offer: "5" }), pro))).toEqual(["min_offer"]);
		expect(fields(validateImportRow(single({ offers: "min" }), pro))).toEqual(["min_offer"]);
	});

	it("rejects photo URLs (no server-side fetching) [IO-import-validate]", () => {
		expect(
			issues(validateImportRow(single({ photos: "front.jpg;https://example.com/back.jpg" }), free)),
		).toEqual([
			{
				field: "photos",
				message: "Photo links aren't supported; put the photos in the ZIP and list their file names",
			},
		]);
		expect(fields(validateImportRow(single({ photos: "www.example.com/a.jpg" }), free))).toEqual(["photos"]);
	});

	it("applies the listing policy: no code cards [IO-import-validate]", () => {
		expect(fields(validateImportRow(single({ title: "PTCGL code card" }), free))).toEqual(["title"]);
	});

	it("undoes export formula escaping before validating [IO-import-validate]", () => {
		expect(expectOk(validateImportRow(single({ title: "'-Alpha- Black Lotus" }), free)).title).toBe(
			"-Alpha- Black Lotus",
		);
	});

	it("accepts every template's example row [IO-import-validate]", () => {
		for (const game of GAMES) {
			for (const kind of ITEM_KINDS) {
				const [headers, example] = templateRows(kind, game);
				const cells = Object.fromEntries(headers!.map((h, i) => [h, example![i]!]));
				const template = `${game.slug} ${kind}`;
				expect({ template, issues: issues(validateImportRow(cells, free)) }).toEqual({
					template,
					issues: [],
				});
			}
		}
	});
});

const rows = (...cells: Record<string, string>[]): MappedRow[] =>
	cells.map((c, i) => ({ row: i + 2, cells: c }));

describe("file validation [IO-import-validate]", () => {
	it("collects row errors with spreadsheet row numbers and skips blank rows [IO-import-validate]", () => {
		const result = expectOk(
			validateImport(rows(single(), { title: " ", price: "" }, single({ price: "-1" })), free),
		);
		expect(result.items.map((i) => i.row)).toEqual([2]);
		expect(result.errors.map((e) => [e.row, e.field])).toEqual([[4, "price"]]);
	});

	it("rejects duplicate SKUs and item IDs inside a file [IO-import-validate]", () => {
		const result = expectOk(
			validateImport(
				rows(
					single({ sku: "A" }),
					single({ sku: "a" }),
					single({ item_id: "i1" }),
					single({ item_id: "i1" }),
				),
				free,
			),
		);
		expect(result.items.map((i) => i.row)).toEqual([2, 4]);
		expect(result.errors.map((e) => [e.row, e.field])).toEqual([
			[3, "sku"],
			[5, "item_id"],
		]);
	});

	it("rejects empty files and files over 2,000 rows [IO-import-validate]", () => {
		expect(expectRejected(validateImport(rows({ title: "" }), free))).toBe("empty_file");
		const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => single());
		expect(expectRejected(validateImport(rows(...many), free))).toBe("too_many_rows");
		expect(expectOk(validateImport(rows(...many.slice(1)), pro)).items).toHaveLength(MAX_IMPORT_ROWS);
	});
});

describe("import target [IO-import-target]", () => {
	it("allows draft and scheduled sales only [IO-import-target]", () => {
		expect(checkImportTarget("draft").ok).toBe(true);
		expect(checkImportTarget("scheduled").ok).toBe(true);
		for (const status of ["live", "closed", "archived", "deleted"] satisfies SaleStatus[]) {
			expect(expectRejected(checkImportTarget(status))).toBe("sale_not_importable");
		}
	});
});

const imported = (overrides: Partial<ImportedItem> = {}): ImportedItem => ({
	itemId: null,
	sku: null,
	game: "pokemon",
	kind: "single",
	title: "Charizard ex",
	description: "",
	priceCents: 1240,
	quantity: 1,
	offers: "off",
	minOfferCents: null,
	shippingOverrideCents: null,
	attributes: { name: "Charizard ex", condition: "NM" },
	photos: [],
	...overrides,
});

const existing = (id: string, overrides: Partial<ExistingItem> = {}): ExistingItem => {
	const { itemId: _itemId, photos: _photos, ...importFields } = imported();
	return { ...importFields, id, ...overrides };
};

const planRows = (...items: ImportedItem[]) => items.map((item, i) => ({ row: i + 2, item }));

describe("upsert planning [IO-import-upsert]", () => {
	it("updates by item_id, then by SKU; creates the rest; keeps unlisted items [IO-import-upsert]", () => {
		const plan = planImport({
			rows: planRows(
				imported({ itemId: "i1", priceCents: 1500 }),
				imported({ sku: "SKU-2", title: "Renamed" }),
				imported({ sku: "NEW" }),
			),
			existing: [existing("i1"), existing("i2", { sku: "sku-2" }), existing("i3")],
			removeMissing: false,
			sellerTier: "pro",
		});
		expect(plan.updates.map((u) => [u.itemId, u.changed])).toEqual([
			["i1", ["priceCents"]],
			["i2", ["sku", "title"]],
		]);
		expect(plan.creates.map((c) => c.row)).toEqual([4]);
		expect(plan.removals).toEqual([]);
		expect(plan.outcomes.map((o) => o.outcome)).toEqual(["updated", "updated", "created"]);
	});

	it("skips unchanged rows, and treats listed photos as a change [IO-import-upsert]", () => {
		const plan = planImport({
			rows: planRows(imported({ itemId: "i1" }), imported({ itemId: "i2", photos: ["x.jpg"] })),
			existing: [existing("i1"), existing("i2")],
			removeMissing: false,
			sellerTier: "free",
		});
		expect(plan.outcomes).toEqual([
			{ row: 2, outcome: "skipped", itemId: "i1", reason: "unchanged" },
			{ row: 3, outcome: "updated", itemId: "i2", changed: ["photos"] },
		]);
	});

	it("removes items missing from the file only when the seller opts in [IO-import-upsert]", () => {
		const input = {
			rows: planRows(imported({ itemId: "i1" })),
			existing: [existing("i1"), existing("i2")],
			sellerTier: "free" as const,
		};
		expect(planImport({ ...input, removeMissing: false }).removals).toEqual([]);
		expect(planImport({ ...input, removeMissing: true }).removals).toEqual(["i2"]);
	});

	it("rejects unknown item IDs, SKUs owned by another item and two rows for one item [IO-import-upsert]", () => {
		const plan = planImport({
			rows: planRows(
				imported({ itemId: "nope" }),
				imported({ itemId: "i1", sku: "B" }),
				imported({ sku: "B" }),
				imported({ itemId: "i2" }),
			),
			existing: [existing("i1"), existing("i2", { sku: "B" })],
			removeMissing: false,
			sellerTier: "pro",
		});
		expect(plan.outcomes.map((o) => (o.outcome === "error" ? `error:${o.field}` : o.outcome))).toEqual([
			"error:item_id",
			"error:sku",
			"skipped",
			"error:item_id",
		]);
	});
});

describe("free item cap on import [IO-import-cap]", () => {
	it("plans only the rows that fit and says how many fit [IO-import-cap]", () => {
		const plan = planImport({
			rows: planRows(...Array.from({ length: 5 }, (_, i) => imported({ sku: `N${i}` }))),
			existing: Array.from({ length: 7 }, (_, i) => existing(`i${i}`)),
			removeMissing: false,
			sellerTier: "free",
		});
		expect(plan.cap).toEqual({ limit: FREE_ITEM_CAP, fits: 3, exceeded: true });
		expect(plan.creates).toHaveLength(3);
		const errors = plan.outcomes.filter((o) => o.outcome === "error");
		expect(errors).toHaveLength(2);
		expect(errors[0]).toMatchObject({ message: "Free sales hold 10 items, so only 3 new rows fit" });
	});

	it("counts removals before the cap, and has no cap for Pro [IO-import-cap]", () => {
		const input = {
			rows: planRows(...Array.from({ length: 12 }, (_, i) => imported({ sku: `N${i}` }))),
			existing: [existing("old")],
		};
		expect(planImport({ ...input, removeMissing: true, sellerTier: "free" }).cap).toEqual({
			limit: 10,
			fits: 10,
			exceeded: true,
		});
		const proPlan = planImport({ ...input, removeMissing: false, sellerTier: "pro" });
		expect(proPlan.cap).toEqual({ limit: null, fits: 12, exceeded: false });
		expect(proPlan.creates).toHaveLength(12);
	});
});
