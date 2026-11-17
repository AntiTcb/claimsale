import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BOM,
	decodeText,
	decodeWindows1252,
	detectDelimiter,
	encodeCsv,
	encodeUtf8,
	isBlankRow,
	parseCsv,
} from "./csv.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("CSV encoding", () => {
	it("writes UTF-8 with a BOM and CRLF, quoting only where needed", () => {
		const text = encodeCsv([
			["title", "price"],
			['Charizard "ex", alt art', "12.40"],
			["line\nbreak", " padded "],
		]);
		expect(text).toBe(
			`${BOM}title,price\r\n"Charizard ""ex"", alt art",12.40\r\n"line\nbreak"," padded "\r\n`,
		);
		expect([...encodeUtf8(text).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	});

	it("can write a ;-delimited file without a BOM", () => {
		expect(encodeCsv([["a;b", "c"]], { delimiter: ";", bom: false })).toBe('"a;b";c\r\n');
	});

	it("parses quotes, embedded delimiters, line breaks and every line ending", () => {
		const text = 'a,b,c\r\n"x, y","say ""hi""","multi\r\nline"\n1,2,3\r4,5,6';
		expect(parseCsv(text)).toEqual([
			["a", "b", "c"],
			["x, y", 'say "hi"', "multi\r\nline"],
			["1", "2", "3"],
			["4", "5", "6"],
		]);
	});

	it("strips an Excel BOM and keeps blank rows for the importer to skip", () => {
		const rows = parseCsv(`${BOM}title,price\r\n\r\n,\r\nPikachu,1.00\r\n`);
		expect(rows).toEqual([["title", "price"], [""], ["", ""], ["Pikachu", "1.00"]]);
		expect(rows.filter((row) => !isBlankRow(row))).toHaveLength(2);
	});

	it("detects ; delimiters from the header, ignoring quoted ones", () => {
		expect(detectDelimiter("title;price;quantity\r\nA,B;1,50;1")).toBe(";");
		expect(detectDelimiter('"a;b;c",d\n')).toBe(",");
		expect(detectDelimiter(`${BOM}sku,title`)).toBe(",");
		expect(parseCsv("title;price\r\nPikachu;1,50")).toEqual([
			["title", "price"],
			["Pikachu", "1,50"],
		]);
	});

	it("round-trips any table (property)", () => {
		const cell = fc.string({ unit: "grapheme" });
		fc.assert(
			fc.property(
				fc
					.array(fc.array(cell, { minLength: 2, maxLength: 5 }), { minLength: 1, maxLength: 8 })
					.filter((rows) => {
						// A single-cell empty row can't be told apart from a blank line; real tables always have ≥ 2 columns.
						return rows.every((row) => row.length >= 2);
					}),
				fc.constantFrom<"," | ";">(",", ";"),
				(rows, delimiter) => {
					const text = encodeCsv(rows, { delimiter });
					expect(parseCsv(decodeText(encodeUtf8(text)).text, delimiter)).toEqual(rows);
				},
			),
		);
	});

	it("parses 2,000 rows", () => {
		const rows = [
			["sku", "title", "price"],
			...Array.from({ length: 2000 }, (_, i) => [`SKU-${i}`, `Card ${i}`, "1.00"]),
		];
		expect(parseCsv(encodeCsv(rows))).toHaveLength(2001);
	});
});

describe("text decoding", () => {
	it("reads UTF-8 with or without a BOM", () => {
		expect(decodeText(encodeUtf8(`${BOM}Pokémon`))).toEqual({ text: "Pokémon", encoding: "utf-8" });
		expect(decodeText(encodeUtf8("Pokémon"))).toEqual({ text: "Pokémon", encoding: "utf-8" });
	});

	it("falls back to Windows-1252 for Excel's ANSI CSVs", () => {
		// "Pokémon – €5" in Windows-1252: é = E9, en dash = 96, € = 80.
		const ansi = bytes(0x50, 0x6f, 0x6b, 0xe9, 0x6d, 0x6f, 0x6e, 0x20, 0x96, 0x20, 0x80, 0x35);
		expect(decodeText(ansi)).toEqual({ text: "Pokémon – €5", encoding: "windows-1252" });
		expect(decodeWindows1252(bytes(0x93, 0x94, 0x99, 0x9f))).toBe("“”™Ÿ");
	});

	it("reads big-endian UTF-16 with a BOM", () => {
		expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x41, 0x00, 0xe9))).toEqual({
			text: "Aé",
			encoding: "utf-16be",
		});
	});

	it("reads UTF-16 files with a BOM (Excel's Unicode text)", () => {
		expect(decodeText(bytes(0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00))).toEqual({
			text: "Aé",
			encoding: "utf-16le",
		});
	});
});
