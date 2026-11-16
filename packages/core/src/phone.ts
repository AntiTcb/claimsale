import type { Validated } from "./identity.ts";

/**
 * Phone numbers for seller verification (PLAN §5 "Auth and identity", D55, TECH_STACK S10).
 * Numbers are stored in E.164 (`+` and 8–15 digits), unique per account, and never
 * shown publicly; the owner sees them masked.
 */

const valid = <T>(value: T): Validated<T> => ({ ok: true, value });
const invalid = (message: string): Validated<never> => ({ ok: false, message });

/** E.164: a country code that doesn't start with 0, at most 15 digits in all (ITU-T E.164). */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalizes what someone typed into E.164.
 *
 * @spec AUTH-phone-e164 — numbers are stored in E.164.
 *
 * Accepts `+<country code>…` or `00<country code>…` with spaces, dots, dashes and
 * parentheses. Without a country code, a 10-digit number (or 11 starting with 1) is
 * read as North American (+1), the launch market. +1 numbers must be valid NANP
 * numbers (area code and exchange don't start with 0 or 1).
 */
export function normalizePhone(raw: unknown): Validated<string> {
	if (typeof raw !== "string" || raw.trim() === "") return invalid("Enter your mobile number");
	const trimmed = raw.trim();
	if (!/^[+\d\s().-]+$/.test(trimmed)) return invalid("Use digits only, with an optional + in front");
	if (trimmed.indexOf("+") > 0 || trimmed.split("+").length > 2)
		return invalid("Use digits only, with an optional + in front");
	const digits = trimmed.replace(/\D/g, "");
	let e164: string;
	if (trimmed.startsWith("+")) e164 = `+${digits}`;
	else if (digits.startsWith("00")) e164 = `+${digits.slice(2)}`;
	else if (digits.length === 10) e164 = `+1${digits}`;
	else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
	else return invalid("Include your country code, like +44 7700 900123");
	if (!E164.test(e164)) return invalid("That doesn't look like a phone number");
	if (e164.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) {
		return invalid("That isn't a valid US or Canadian number");
	}
	return valid(e164);
}

/** For the owner's own settings page: the country code and the last 4 digits only. */
export function maskPhoneForOwner(e164: string): string {
	const last4 = e164.slice(-4);
	const country = e164.startsWith("+1") ? "+1" : e164.slice(0, 3);
	return `${country} ••• ${last4}`;
}

export const PHONE_CODE_LENGTH = 6;

/** The one-time code from the text message: 6 digits, spaces and dashes ignored. */
export function validatePhoneCode(raw: unknown): Validated<string> {
	if (typeof raw !== "string") return invalid("Enter the 6-digit code");
	const code = raw.replace(/[\s-]/g, "");
	if (!new RegExp(`^\\d{${PHONE_CODE_LENGTH}}$`).test(code)) return invalid("Enter the 6-digit code");
	return valid(code);
}

/**
 * Line types from Twilio Lookup's line type intelligence that may verify a seller
 * (TECH_STACK S10: no VoIP). Unknown types (`null`, `unknown`) are allowed, since
 * Lookup can't classify every country's numbers; everything else can't get a code.
 */
const ALLOWED_LINE_TYPES = new Set(["mobile", "personal", "unknown"]);

export function phoneLineTypeAllowed(lineType: string | null | undefined): boolean {
	return lineType === null || lineType === undefined || ALLOWED_LINE_TYPES.has(lineType);
}
