import { describe, expect, it } from "vitest";
import { expectOk } from "../testing.ts";
import { parseCsv } from "./csv.ts";
import { validateImport } from "./import.ts";
import {
	autoMapColumns,
	detectPreset,
	MANABOX_PRESET,
	mapRows,
	mapRowsWithPreset,
	TCGPLAYER_PRESET,
} from "./mapping.ts";

describe("column mapping", () => {
	it("maps our own headers exactly and common synonyms, ignoring export-only columns", () => {
		const { mapping, unmapped } = autoMapColumns([
			"SKU",
			"Item Type",
			"Card Name",
			"Collector Number",
			"Qty",
			"Price",
			"status",
			"winner_handle",
			"Notes to self",
		]);
		expect(mapping).toEqual({
			SKU: "sku",
			"Item Type": "kind",
			"Card Name": "name",
			"Collector Number": "number",
			Qty: "quantity",
			Price: "price",
			status: null,
			winner_handle: null,
			"Notes to self": null,
		});
		expect(unmapped).toEqual(["Notes to self"]);
	});

	it("maps a field only once", () => {
		expect(autoMapColumns(["qty", "quantity"]).mapping).toEqual({ qty: "quantity", quantity: null });
	});

	it("applies a mapping, dropping blank rows and numbering rows like the spreadsheet", () => {
		const table = parseCsv("Name;Prix;Ignored\r\nPikachu;1,50;x\r\n;;\r\nEevee;2;y\r\n");
		const rows = mapRows(table, { Name: "name", Prix: "price", Ignored: null });
		expect(rows).toEqual([
			{ row: 2, cells: { name: "Pikachu", price: "1,50" } },
			{ row: 4, cells: { name: "Eevee", price: "2" } },
		]);
	});

	it("ignores unnamed columns and reads short rows as blanks", () => {
		const { mapping, unmapped } = autoMapColumns(["name", "", "price"]);
		expect(unmapped).toEqual([]);
		expect(mapRows([["name", "", "price"], ["Pikachu"]], mapping)).toEqual([
			{ row: 2, cells: { name: "Pikachu", price: "" } },
		]);
	});
});

describe("preset detection and edge rows", () => {
	const HEADER =
		"TCGplayer Id,Product Line,Product Name,Number,Condition,Total Quantity,TCG Marketplace Price";
	const tcgRows = (...lines: string[]) =>
		mapRowsWithPreset(parseCsv([HEADER, ...lines].join("\n")), TCGPLAYER_PRESET).map((r) => r.cells);

	it("finds no preset for our own headers", () => {
		expect(detectPreset(["sku", "game", "kind", "title"])).toBeNull();
	});

	it("detects ManaBox by its Scryfall columns and defaults a blank Foil to non-foil", () => {
		const table = parseCsv(
			"Name,Set code,Collector number,Scryfall ID,Foil\nSol Ring,fdn,248,abc,\n,,,,\nBolt,2xm",
		);
		expect(detectPreset(table[0]!)).toBe(MANABOX_PRESET);
		const rows = mapRowsWithPreset(table, MANABOX_PRESET);
		expect(rows.map((r) => r.row)).toEqual([2, 4]);
		expect(rows[0]!.cells["finish"]).toBe("non-foil");
		expect(rows[1]!.cells["number"]).toBe("");
	});

	it("reads TCGplayer's plain printing as non-holo or non-foil, and Foil per game", () => {
		const [pokemon, mtg, mtgFoil] = tcgRows(
			"1,Pokemon,Pikachu,1,Near Mint,1,1.00",
			"2,Magic,Sol Ring,1,Near Mint,1,1.00",
			"3,Magic,Sol Ring,1,Lightly Played Holofoil,1,1.00",
		);
		expect(pokemon).toMatchObject({ condition: "Near Mint", finish: "non-holo" });
		expect(mtg).toMatchObject({ finish: "non-foil" });
		expect(mtgFoil).toMatchObject({ condition: "Lightly Played", finish: "foil" });
	});

	it("passes unknown product lines and conditions through for validation to flag", () => {
		const [row] = tcgRows("1,Hearthstone,Ragnaros,1,Mint,1,1.00");
		expect(row).toMatchObject({ game: "Hearthstone", condition: "Mint", finish: "" });
		const result = expectOk(validateImport([{ row: 2, cells: row! }], { sellerTier: "free" }));
		expect(result.errors.map((e) => e.field)).toContain("game");
	});
});

const TCGPLAYER_CSV = [
	"TCGplayer Id,Product Line,Set Name,Product Name,Title,Number,Rarity,Condition,TCG Market Price,TCG Direct Low,TCG Low Price With Shipping,TCG Low Price,Total Quantity,Add to Quantity,TCG Marketplace Price,Photo URL",
	"509876,Pokemon,Obsidian Flames,Charizard ex,,125/197,Double Rare,Near Mint Holofoil,45.10,,,40.00,1,0,42.00,",
	"111,Pokemon,Base Set,Pikachu,,58/102,Common,Lightly Played 1st Edition Reverse Holofoil,5.00,,,4.00,2,0,4.50,https://example.com/p.jpg",
	"222,YuGiOh,Legend of Blue Eyes,Dark Magician,,LOB-005,Ultra Rare,Near Mint 1st Edition,100.00,,,90.00,1,0,95.00,",
	"333,Magic,Foundations,Sol Ring,,1,Uncommon,Moderately Played Foil,3.00,,,2.00,0,0,2.50,",
	"444,Pokemon,Obsidian Flames,Obsidian Flames Booster Box,,,,Unopened,150.00,,,140.00,1,0,155.00,",
].join("\r\n");

describe("TCGplayer preset", () => {
	const table = parseCsv(TCGPLAYER_CSV);

	it("is detected from the headers", () => {
		expect(detectPreset(table[0]!)?.id).toBe("tcgplayer");
	});

	it("splits Condition into condition, finish and edition, and skips zero-quantity rows", () => {
		const rows = mapRowsWithPreset(table, TCGPLAYER_PRESET);
		expect(rows.map((r) => r.row)).toEqual([2, 3, 4, 6]);
		expect(rows[0]!.cells).toMatchObject({
			game: "pokemon",
			kind: "single",
			tcgplayer_product_id: "509876",
			name: "Charizard ex",
			condition: "Near Mint",
			finish: "holo",
			price: "42.00",
		});
		expect(rows[1]!.cells).toMatchObject({
			condition: "Lightly Played",
			finish: "reverse-holo",
			edition: "1st Edition",
		});
		expect(rows[2]!.cells).toMatchObject({ game: "yugioh", edition: "1st Edition", finish: "" });
		expect(rows[3]!.cells).toMatchObject({ kind: "sealed", name: "Obsidian Flames Booster Box" });
	});

	it("never imports market prices or photo URLs (D64)", () => {
		for (const row of mapRowsWithPreset(table, TCGPLAYER_PRESET)) {
			expect(Object.values(row.cells)).not.toContain("45.10");
			expect(Object.keys(row.cells).some((key) => /market|photo/i.test(key))).toBe(false);
		}
	});

	it("produces rows that validate", () => {
		const result = expectOk(
			validateImport(mapRowsWithPreset(table, TCGPLAYER_PRESET), { sellerTier: "free" }),
		);
		expect(result.errors).toEqual([]);
		expect(
			result.items.map((i) => [i.item.kind, i.item.attributes["condition"], i.item.attributes["finish"]]),
		).toEqual([
			["single", "NM", "holo"],
			["single", "LP", "reverse-holo"],
			["single", "NM", undefined],
			["sealed", undefined, undefined],
		]);
		expect(result.items[2]!.item.attributes["edition"]).toBe("1st");
	});
});

const MANABOX_CSV = [
	"Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency",
	"Sol Ring,fdn,Foundations,248,normal,uncommon,1,123,abc,1.20,false,false,near_mint,en,USD",
	"Lightning Bolt,2xm,Double Masters,129,foil,uncommon,2,124,def,3.00,false,true,lightly_played,en,USD",
].join("\n");

describe("ManaBox preset", () => {
	const table = parseCsv(MANABOX_CSV);

	it("is detected and maps MTG singles without a price (purchase price isn't an asking price)", () => {
		expect(detectPreset(table[0]!)).toBe(MANABOX_PRESET);
		const rows = mapRowsWithPreset(table, MANABOX_PRESET);
		expect(rows[0]!.cells).toMatchObject({
			game: "mtg",
			set_code: "FDN",
			number: "248",
			finish: "normal",
			condition: "near_mint",
		});
		expect(rows[0]!.cells["price"]).toBeUndefined();
		expect(rows[1]!.cells["altered"]).toBe("yes");
	});

	it("validates once the seller fills in prices", () => {
		const rows = mapRowsWithPreset(table, MANABOX_PRESET).map((r) => ({
			...r,
			cells: { ...r.cells, price: "1.00" },
		}));
		const result = expectOk(validateImport(rows, { sellerTier: "free" }));
		expect(result.errors).toEqual([]);
		expect(
			result.items.map((i) => [
				i.item.attributes["condition"],
				i.item.attributes["finish"],
				i.item.attributes["altered"],
			]),
		).toEqual([
			["NM", "non-foil", undefined],
			["LP", "foil", true],
		]);
	});
});
