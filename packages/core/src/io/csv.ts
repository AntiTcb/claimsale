/**
 * CSV encoding rules for imports and exports (PLAN §3c.4). The browser parses with
 * papaparse for the instant preview; this small RFC 4180 reader/writer exists so the
 * server and the pure round-trip tests (IO-export-roundtrip) don't need a parser
 * dependency in core.
 *
 * - Exports are UTF-8 with a BOM (so Excel opens them correctly) and CRLF line ends.
 * - Imports accept UTF-8 (with or without a BOM), UTF-16 with a BOM, and
 *   Windows-1252, and auto-detect `,` or `;` delimiters.
 */

// Core compiles against ES2024 only (no DOM / Workers lib); these Encoding API globals
// exist in every runtime core runs in (browsers, Workers, Node).
declare const TextDecoder: new (
	label?: string,
	options?: { readonly fatal?: boolean },
) => { decode(input: Uint8Array): string };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

export type Delimiter = "," | ";";

export const BOM = "﻿";

const stripBom = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text);

/**
 * Picks `,` or `;` from the header line (Excel in many European locales saves `;`).
 * Delimiters inside quotes don't count; ties go to `,`.
 */
export function detectDelimiter(text: string): Delimiter {
	let commas = 0;
	let semicolons = 0;
	let quoted = false;
	for (const char of stripBom(text)) {
		if (char === '"') quoted = !quoted;
		else if (!quoted && (char === "\n" || char === "\r")) break;
		else if (!quoted && char === ",") commas++;
		else if (!quoted && char === ";") semicolons++;
	}
	return semicolons > commas ? ";" : ",";
}

/**
 * Parses CSV text into rows of cells. Quoted cells may contain delimiters, quotes
 * (doubled) and line breaks; CRLF, LF and CR all end a row. A trailing line break
 * doesn't add an empty row. Blank rows are kept (see {@link isBlankRow}).
 */
export function parseCsv(input: string, delimiter: Delimiter = detectDelimiter(input)): string[][] {
	const text = stripBom(input);
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let i = 0;
	while (i < text.length) {
		const char = text[i]!;
		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i += 2;
					continue;
				}
				quoted = false;
			} else {
				cell += char;
			}
			i++;
			continue;
		}
		if (char === '"' && cell === "") {
			quoted = true;
		} else if (char === delimiter) {
			row.push(cell);
			cell = "";
		} else if (char === "\r" || char === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			if (char === "\r" && text[i + 1] === "\n") i++;
		} else {
			cell += char;
		}
		i++;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

export const isBlankRow = (row: readonly string[]): boolean => row.every((cell) => cell.trim() === "");

function encodeCell(cell: string, delimiter: Delimiter): string {
	return /["\r\n]/.test(cell) || cell.includes(delimiter) || cell !== cell.trim()
		? `"${cell.replaceAll('"', '""')}"`
		: cell;
}

/**
 * Writes rows as CSV text: a BOM, CRLF line ends, and quotes only where needed.
 * Cells must already be formula-escaped (see escapeFormula).
 */
export function encodeCsv(
	rows: readonly (readonly string[])[],
	options: { readonly delimiter?: Delimiter; readonly bom?: boolean } = {},
): string {
	const delimiter = options.delimiter ?? ",";
	const body = rows.map((row) => row.map((cell) => encodeCell(cell, delimiter)).join(delimiter)).join("\r\n");
	return ((options.bom ?? true) ? BOM : "") + body + "\r\n";
}

/** Windows-1252 bytes 0x80–0x9F; the rest of the range matches Latin-1. */
const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
	0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a,
	0x153, 0x9d, 0x17e, 0x178,
];

/** Decodes Windows-1252 without relying on the runtime's TextDecoder label support. */
export function decodeWindows1252(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) {
		out += String.fromCharCode(byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : byte);
	}
	return out;
}

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

/**
 * Decodes an uploaded file: a BOM wins; otherwise strict UTF-8, falling back to
 * Windows-1252 (what Excel on Windows writes for "CSV" without UTF-8).
 */
export function decodeText(bytes: Uint8Array): { readonly text: string; readonly encoding: TextEncoding } {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
	}
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
	}
	if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
	}
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
	} catch {
		return { text: decodeWindows1252(bytes), encoding: "windows-1252" };
	}
}

/** UTF-8 bytes for an export file; {@link encodeCsv} already adds the BOM. */
export const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
