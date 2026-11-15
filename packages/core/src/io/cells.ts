import { err, ok, type Result } from "../common.ts";
import type { Cents } from "../money.ts";

/** Cell-level rules shared by every import and export (PLAN §3c). */

/** The most a price cell may say: $1,000,000.00. */
export const MAX_PRICE_CENTS: Cents = 100_000_000;

const PLAIN = /^(\d+)(?:[.,](\d{1,2}))?$/;
const US_THOUSANDS = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;
// "1.234,56" only: a bare "12.345" is far more likely a typo than twelve thousand dollars.
const EU_THOUSANDS = /^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/;

/**
 * Reads a money cell into integer cents without floating point: `12`, `12.4`,
 * `$12.40`, `12,40` (a `;`-delimited European file), `1,234.56` and `1.234,56`.
 * Negative and fractional-cent values are rejected.
 */
export function parseCents(raw: string): Result<Cents, string> {
	const value = raw
		.trim()
		.replace(/^(?:US)?\$\s*/i, "")
		.replace(/\s*(?:USD)$/i, "");
	let whole: string | undefined;
	let fraction: string | undefined;
	const plain = PLAIN.exec(value);
	const us = plain ? null : US_THOUSANDS.exec(value);
	const eu = plain || us ? null : EU_THOUSANDS.exec(value);
	if (plain) [, whole, fraction] = plain;
	else if (us) {
		whole = us[1]!.replaceAll(",", "");
		fraction = us[2];
	} else if (eu) {
		whole = eu[1]!.replaceAll(".", "");
		fraction = eu[2];
	} else return err(`"${raw.trim()}" isn't an amount like 12.40`);
	const cents = Number(whole) * 100 + Number((fraction ?? "0").padEnd(2, "0"));
	if (!Number.isSafeInteger(cents) || cents > MAX_PRICE_CENTS)
		return err("Amounts can be at most $1,000,000.00");
	return ok(cents);
}

/** `1240` → `"12.40"`: the plain form exports use, which {@link parseCents} reads back. */
export function formatCentsPlain(cents: Cents): string {
	if (!Number.isSafeInteger(cents) || cents < 0)
		throw new RangeError(`cents must be a non-negative integer, got ${cents}`);
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Characters that make a spreadsheet treat a cell as a formula (CWE-1236). */
const FORMULA_START = /^'*[=+\-@\t\r]/;
const ESCAPED = /^'+[=+\-@\t\r]/;

/**
 * Escapes a cell for a spreadsheet export.
 *
 * @spec IO-export-formula-escape
 *
 * A cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`, so Excel and
 * Sheets show it as text. Cells that already start with `'` before one of those get
 * one more, so {@link unescapeFormula} can always undo exactly what this did.
 */
export function escapeFormula(cell: string): string {
	return FORMULA_START.test(cell) ? `'${cell}` : cell;
}

/** Undoes {@link escapeFormula} on import, so a re-imported export is unchanged. */
export function unescapeFormula(cell: string): string {
	return ESCAPED.test(cell) ? cell.slice(1) : cell;
}
