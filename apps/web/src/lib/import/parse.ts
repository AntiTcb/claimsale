import { decodeText, detectDelimiter } from "@claimsale/core";
import Papa from "papaparse";

/**
 * Reading an import file in the browser (PLAN §3c.4): CSV through papaparse, XLSX
 * through read-excel-file, both into a table of strings with the header row first.
 * Core's `decodeText` handles the encoding (UTF-8 with or without a BOM, UTF-16,
 * Windows-1252) and `detectDelimiter` picks `,` or `;`.
 */

export type Table = string[][];
export type FileFormat = "csv" | "xlsx";

/** Far above 2,000 rows of any template; a guard against picking the wrong file. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class ImportFileError extends Error {
	override readonly name = "ImportFileError";
}

export function fileFormat(file: Pick<File, "name" | "type">): FileFormat | null {
	const name = file.name.toLowerCase();
	if (
		name.endsWith(".xlsx") ||
		file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	)
		return "xlsx";
	if (name.endsWith(".csv") || name.endsWith(".txt") || file.type === "text/csv") return "csv";
	return null;
}

/** Parses CSV text into rows; quoted cells keep delimiters, quotes and line breaks. */
export function parseCsvText(text: string): Table {
	const result = Papa.parse<string[]>(text, { delimiter: detectDelimiter(text), skipEmptyLines: false });
	return result.data.map((row) => row.map((cell) => cell ?? ""));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** One spreadsheet cell as text: numbers as typed, dates as YYYY-MM-DD, booleans as yes / no. */
export function cellText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (value instanceof Date) {
		return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
	}
	return typeof value === "bigint" ? value.toString() : "";
}

/** Drops trailing rows that are entirely blank (spreadsheets often carry a few). */
function trimTable(table: Table): Table {
	let end = table.length;
	while (end > 0 && table[end - 1]!.every((cell) => cell.trim() === "")) end--;
	return table.slice(0, end);
}

export async function parseSpreadsheet(file: File): Promise<{ table: Table; format: FileFormat }> {
	const format = fileFormat(file);
	if (format === null) throw new ImportFileError("Choose a CSV or Excel (.xlsx) file.");
	if (file.size > MAX_FILE_BYTES) throw new ImportFileError("That file is larger than 20 MB.");
	if (format === "csv") {
		const { text } = decodeText(new Uint8Array(await file.arrayBuffer()));
		return { table: trimTable(parseCsvText(text)), format };
	}
	try {
		// Loaded on demand: only XLSX imports need it.
		const { readSheet } = await import("read-excel-file/browser");
		const rows = await readSheet(file);
		return { table: trimTable(rows.map((row) => row.map(cellText))), format };
	} catch {
		throw new ImportFileError("That Excel file couldn't be read. Save it again as .xlsx or CSV.");
	}
}
