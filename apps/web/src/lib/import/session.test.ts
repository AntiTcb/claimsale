import { autoMapColumns, MANABOX_PRESET, parseCsv } from "@claimsale/core";
import { describe, expect, it } from "vitest";
import { cellText, parseCsvText } from "./parse.ts";
import {
	blankPriceItems,
	chunk,
	fillPrices,
	keptByFile,
	mappedRows,
	previewBlankPrices,
	previewRows,
	resultsCsv,
	setCell,
	type RowOutcome,
} from "./session.ts";

const csv = [
	"sku,game,kind,name,condition,price,photos",
	"A,yugioh,single,Blue-Eyes White Dragon,NM,40,bewd.jpg",
	"B,yugioh,single,Dark Magician,LP,,",
	",,,,,,",
	"C,yugioh,single,=HYPERLINK(),Mint-ish,5,",
].join("\r\n");

describe("import session", () => {
	it("parses CSV with papaparse, detecting ; delimiters and quoted cells", () => {
		expect(parseCsvText('a;b\r\n"x;y";"say ""hi"""\r\n')).toEqual([["a", "b"], ["x;y", 'say "hi"'], [""]]);
		expect(parseCsvText(csv)).toEqual(parseCsv(csv));
		expect([
			cellText(12.4),
			cellText(true),
			cellText(null),
			cellText(new Date(Date.UTC(2026, 0, 2))),
		]).toEqual(["12.4", "yes", "", "2026-01-02"]);
	});

	it("[IO-import-validate] previews every row with core's validation, blank rows dropped", () => {
		const table = parseCsvText(csv);
		const rows = mappedRows(table, { kind: "columns", mapping: autoMapColumns(table[0]!).mapping });
		expect(rows.map((r) => r.row)).toEqual([2, 3, 5]);
		const preview = previewRows(rows, "free");
		expect(preview.fileError).toBeNull();
		expect(preview.rows.map((r) => [r.row, r.ok])).toEqual([
			[2, true],
			[3, false],
			[5, false],
		]);
		const third = preview.rows[2]!;
		expect(third.ok ? [] : third.errors.map((e) => e.field)).toContain("condition");
		expect(previewRows([], "free").fileError).toBe("The file has no item rows");
	});

	it("[TCG-market-pct] previews N % of market for blank prices, then fills exactly the preview", () => {
		const table = parseCsvText(csv);
		const rows = mappedRows(table, { kind: "columns", mapping: autoMapColumns(table[0]!).mapping });
		const blank = blankPriceItems(rows, "free");
		expect(blank.map((b) => b.row)).toEqual([3]);
		const preview = previewBlankPrices(
			[
				{ row: 3, marketCents: 1240 },
				{ row: 9, marketCents: null },
			],
			80,
		);
		expect(preview.changes).toEqual([{ itemId: "3", fromCents: null, toCents: 975 }]);
		expect(preview.skipped).toEqual([{ itemId: "9", reason: "no_market" }]);
		const filled = fillPrices(rows, preview);
		expect(filled.find((r) => r.row === 3)?.cells["price"]).toBe("9.75");
		expect(filled.find((r) => r.row === 2)).toBe(rows[0]);
		expect(previewRows(filled, "free").rows.find((r) => r.row === 3)?.ok).toBe(true);
	});

	it("maps a ManaBox export with its preset; prices start blank", () => {
		const table = parseCsvText(
			"Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Condition,Language\r\n" +
				"Sol Ring,c21,Commander 2021,263,normal,uncommon,2,1,x,near_mint,en\r\n",
		);
		const rows = mappedRows(table, { kind: "preset", preset: MANABOX_PRESET });
		expect(rows[0]!.cells).toMatchObject({ game: "mtg", name: "Sol Ring", set_code: "C21" });
		expect(blankPriceItems(rows, "free").map((b) => b.row)).toEqual([2]);
	});

	it("batches by 100, sets cells, and keeps every SKU and item_id the file names", () => {
		expect(chunk(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([100, 100, 50]);
		const rows = [
			{ row: 2, cells: { sku: "A", price: "" } },
			{ row: 3, cells: { item_id: "item-1", sku: " " } },
		];
		expect(setCell(rows, 2, "tcgplayer_product_id", "5001")[0]!.cells).toEqual({
			sku: "A",
			price: "",
			tcgplayer_product_id: "5001",
		});
		expect(keptByFile(rows)).toEqual({ keepItemIds: ["item-1"], keepSkus: ["A"] });
	});

	it("writes the results file: the seller's columns plus result and message, formula-escaped", () => {
		const table = parseCsvText(csv);
		const outcomes = new Map<number, RowOutcome>([
			[2, { row: 2, outcome: "created", itemId: "i1", message: "" }],
			[5, { row: 5, outcome: "error", itemId: null, message: "condition: Condition must be one of: NM" }],
		]);
		const text = resultsCsv(table, outcomes);
		const back = parseCsv(text);
		expect(back[0]).toEqual([...table[0]!, "result", "message"]);
		expect(back[1]!.slice(-2)).toEqual(["created", ""]);
		expect(back[2]!.slice(-2)).toEqual(["", ""]);
		expect(back[4]![3]).toBe("'=HYPERLINK()");
		expect(back[4]!.slice(-2)).toEqual(["error", "condition: Condition must be one of: NM"]);
	});
});
