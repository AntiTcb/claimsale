/**
 * PII redaction for logs (TECH_STACK §4): emails and phone numbers are never
 * logged raw, and secrets and message bodies are never logged at all.
 */

const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|otp|session/i;
const BODY_KEY = /^(body|message_body|text|html|note|contest_text|explanation)$/i;
const EMAIL_KEY = /e-?mail/i;
const PHONE_KEY = /phone|e164|msisdn/i;

// Permissive on purpose: any local part RFC 5322 allows unquoted, then a dotted domain.
const EMAIL = /[^\s@<>()[\]\\,;:"]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)+)/gi;
// Seven or more digits, optionally separated, with an optional leading "+".
const PHONE = /\+?\d(?:[\s().-]{0,2}\d){6,}/g;

const MAX_DEPTH = 6;

export function maskEmail(value: string): string {
	return value.replace(EMAIL, (_match, domain: string) => `***@${domain}`);
}

export function maskPhone(value: string): string {
	return value.replace(PHONE, (match) => {
		const digits = match.replace(/\D/g, "");
		return `***${digits.slice(-2)}`;
	});
}

function redactString(key: string | undefined, value: string): string {
	if (key !== undefined) {
		if (SECRET_KEY.test(key)) return "[redacted]";
		if (BODY_KEY.test(key)) return `[redacted ${value.length} chars]`;
		if (EMAIL_KEY.test(key)) return maskEmail(value);
		if (PHONE_KEY.test(key)) return maskPhone(value);
	}
	return maskPhone(maskEmail(value));
}

/** Returns a deep copy of `value` that is safe to write to logs. */
export function redact(value: unknown, key?: string, depth = 0): unknown {
	if (typeof value === "string") return redactString(key, value);
	if (value === null || typeof value !== "object") {
		return key !== undefined && SECRET_KEY.test(key) && value !== undefined ? "[redacted]" : value;
	}
	if (depth >= MAX_DEPTH) return "[truncated]";
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) {
		return { name: value.name, message: redactString(undefined, value.message) };
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, key, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = redact(v, k, depth + 1);
	}
	return out;
}
