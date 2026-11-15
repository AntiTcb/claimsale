import { phoneLineTypeAllowed } from "@claimsale/core";
import type { Db } from "@claimsale/db";
import { and, desc, eq, gt } from "@claimsale/db";
import { verifications } from "@claimsale/db/schema";
import { redact } from "@claimsale/observability";
import { uuidv7 } from "uuidv7";

/**
 * Sends and checks phone verification codes (D55, TECH_STACK S10, S41). Mirrors the
 * mailer: the `SMS` var picks the mode.
 *
 * - `twilio`: Twilio Verify sends the code and checks it; Twilio Lookup first refuses
 *   VoIP and other non-mobile lines. Needs TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET
 *   and TWILIO_VERIFY_SERVICE_SID; without them, verification is unavailable.
 * - `capture`: no text is sent. The code is stored in `verifications` (identifier
 *   `sms-code:<E.164>`), where E2E tests read it through `/api/test/sms`.
 *
 * Any other value fails closed to `twilio`, so a typo can't capture real codes.
 * Numbers and codes are never logged raw.
 */

export type SmsMode = "twilio" | "capture";

export type StartOutcome = "sent" | "invalid_number" | "line_type" | "too_many" | "unavailable";
export type CheckOutcome = "approved" | "wrong" | "expired" | "too_many" | "unavailable";

export interface PhoneVerifier {
	readonly mode: SmsMode;
	/** False when Twilio credentials are missing: nobody can verify a phone here. */
	readonly available: boolean;
	start(e164: string): Promise<StartOutcome>;
	check(e164: string, code: string): Promise<CheckOutcome>;
}

export interface TwilioCredentials {
	readonly apiKeySid: string;
	readonly apiKeySecret: string;
	readonly verifyServiceSid: string;
}

export interface PhoneVerifierDeps {
	readonly mode: string;
	readonly db: Db;
	readonly twilio?: TwilioCredentials | undefined;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	/** A random 6-digit code (capture mode). */
	readonly code?: () => string;
	readonly log?: (record: Record<string, unknown>) => void;
}

/** How long a captured code stays valid; Twilio Verify's default is also 10 minutes. */
export const CODE_TTL_MS = 10 * 60_000;
export const CAPTURE_PREFIX = "sms-code:";

function randomCode(): string {
	const [n = 0] = crypto.getRandomValues(new Uint32Array(1));
	return String(n % 1_000_000).padStart(6, "0");
}

function defaultLog(record: Record<string, unknown>): void {
	// oxlint-disable-next-line no-console -- one structured line, already redacted
	console.log(JSON.stringify({ level: "info", ...record }));
}

/** Masks numbers and scrubs secrets in each value (TECH_STACK §4). */
function redacted(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redact(value, key)]));
}

/** A property of a JSON value, or undefined. */
function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

async function jsonOf(res: Response): Promise<unknown> {
	return res.json().catch(() => undefined);
}

async function errorCode(res: Response): Promise<number | undefined> {
	const code = prop(await jsonOf(res), "code");
	return typeof code === "number" ? code : undefined;
}

const identifier = (e164: string) => `${CAPTURE_PREFIX}${e164}`;
const unavailable = async () => "unavailable" as const;

export function makePhoneVerifier(deps: PhoneVerifierDeps): PhoneVerifier {
	const now = deps.now ?? Date.now;
	const sink = deps.log ?? defaultLog;
	// Redacted before any sink sees it: numbers are masked, codes and errors scrubbed.
	const log = (record: Record<string, unknown>) => sink(redacted(record));
	if (deps.mode === "capture") return captureVerifier(deps.db, now, deps.code ?? randomCode, log);
	return twilioVerifier(deps.twilio, deps.fetch ?? fetch, log);
}

function captureVerifier(
	db: Db,
	now: () => number,
	code: () => string,
	log: (record: Record<string, unknown>) => void,
): PhoneVerifier {
	return {
		mode: "capture",
		available: true,
		async start(e164) {
			const at = new Date(now());
			await db.delete(verifications).where(eq(verifications.identifier, identifier(e164)));
			await db.insert(verifications).values({
				id: uuidv7(),
				identifier: identifier(e164),
				value: code(),
				expiresAt: new Date(at.getTime() + CODE_TTL_MS),
				createdAt: at,
				updatedAt: at,
			});
			log({ msg: "sms code captured", phone: e164 });
			return "sent";
		},
		async check(e164, attempt) {
			const row = await db
				.select({ id: verifications.id, value: verifications.value })
				.from(verifications)
				.where(
					and(eq(verifications.identifier, identifier(e164)), gt(verifications.expiresAt, new Date(now()))),
				)
				.orderBy(desc(verifications.createdAt))
				.get();
			if (!row) return "expired";
			if (row.value !== attempt) return "wrong";
			await db.delete(verifications).where(eq(verifications.id, row.id));
			return "approved";
		},
	};
}

/** Twilio error codes (https://www.twilio.com/docs/api/errors) that mean "slow down". */
const TOO_MANY = new Set([20429, 60202, 60203]);
/** …and the ones that mean the number itself can't get a code. */
const BAD_NUMBER = new Set([21211, 21408, 21610, 21612, 21614, 60200, 60205, 60410, 60605]);

function twilioVerifier(
	credentials: TwilioCredentials | undefined,
	fetcher: typeof fetch,
	log: (record: Record<string, unknown>) => void,
): PhoneVerifier {
	if (!credentials) return { mode: "twilio", available: false, start: unavailable, check: unavailable };
	const auth = `Basic ${btoa(`${credentials.apiKeySid}:${credentials.apiKeySecret}`)}`;
	const service = `https://verify.twilio.com/v2/Services/${encodeURIComponent(credentials.verifyServiceSid)}`;
	const post = (url: string, form: Record<string, string>) =>
		fetcher(url, {
			method: "POST",
			headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form),
		});

	return {
		mode: "twilio",
		available: true,
		async start(e164) {
			try {
				const lookup = await fetcher(
					`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
					{ headers: { authorization: auth } },
				);
				if (lookup.ok) {
					const info = await jsonOf(lookup);
					if (prop(info, "valid") === false) return "invalid_number";
					const type = prop(prop(info, "line_type_intelligence"), "type");
					const lineType = typeof type === "string" ? type : null;
					if (!phoneLineTypeAllowed(lineType)) {
						log({ msg: "sms number refused", phone: e164, line_type: lineType });
						return "line_type";
					}
				} else {
					// Lookup is a screen, not the gate: Verify still validates the number.
					log({ level: "warn", msg: "sms lookup failed", status: lookup.status });
				}
				const res = await post(`${service}/Verifications`, { To: e164, Channel: "sms" });
				if (res.ok) return "sent";
				const code = await errorCode(res);
				log({ level: "warn", msg: "sms send refused", status: res.status, twilio_code: code });
				if (res.status === 429 || (code !== undefined && TOO_MANY.has(code))) return "too_many";
				if (code !== undefined && BAD_NUMBER.has(code)) return "invalid_number";
				return "unavailable";
			} catch (error) {
				log({ level: "error", msg: "sms send failed", error });
				return "unavailable";
			}
		},
		async check(e164, attempt) {
			try {
				const res = await post(`${service}/VerificationCheck`, { To: e164, Code: attempt });
				if (res.ok) {
					return prop(await jsonOf(res), "status") === "approved" ? "approved" : "wrong";
				}
				const code = await errorCode(res);
				if (res.status === 404 || code === 20404) return "expired";
				if (res.status === 429 || (code !== undefined && TOO_MANY.has(code))) return "too_many";
				log({ level: "warn", msg: "sms check refused", status: res.status, twilio_code: code });
				return "unavailable";
			} catch (error) {
				log({ level: "error", msg: "sms check failed", error });
				return "unavailable";
			}
		},
	};
}
