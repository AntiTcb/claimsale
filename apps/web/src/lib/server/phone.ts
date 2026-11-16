import { maskPhoneForOwner, normalizePhone, validatePhoneCode } from "@claimsale/core";
import type { Db } from "@claimsale/db";
import { and, eq, gt, ne } from "@claimsale/db";
import { users, verifications } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";
import { consume, type Limit } from "./rate-limit.ts";
import { CODE_TTL_MS, type PhoneVerifier } from "./sms.ts";
import { isUniqueViolation } from "./users.ts";

/**
 * Phone verification from /me/settings (D55). Starting stores the number being
 * verified in `verifications` (identifier `phone-pending:<user id>`); a correct code
 * writes it to `users.phone_e164` + `phone_verified_at`. The number is only ever
 * shown to its owner, masked.
 *
 * @spec AUTH-phone-e164 — E.164, unique per account, verified by a code, masked for the owner.
 * @spec AUTH-phone-otp-limit — sends limited per account and per number, checks per account.
 */

/** Sends: 5 an hour per account and per number. Checks: 10 per 10 minutes per account. */
export const SEND_LIMIT: Limit = { windowMs: 60 * 60_000, max: 5 };
export const CHECK_LIMIT: Limit = { windowMs: 10 * 60_000, max: 10 };

const PENDING_PREFIX = "phone-pending:";

export type PhoneResult =
	| { readonly ok: true; readonly masked: string }
	| { readonly ok: false; readonly field: "phone" | "code" | "form"; readonly message: string };

const failure = (field: "phone" | "code" | "form", message: string): PhoneResult => ({
	ok: false,
	field,
	message,
});

const UNAVAILABLE = "Phone verification isn't available right now. Try again later.";
const TAKEN = "This number is already verified on another account.";
const SLOW_DOWN = "Too many codes. Wait an hour and try again.";

interface FlowDeps {
	readonly db: Db;
	readonly verifier: PhoneVerifier;
	readonly userId: string;
	readonly now: number;
}

/** The number this user is verifying right now, if a code was sent and hasn't expired. */
export async function pendingPhone(db: Db, userId: string, now: number): Promise<string | undefined> {
	const row = await db
		.select({ value: verifications.value })
		.from(verifications)
		.where(
			and(
				eq(verifications.identifier, `${PENDING_PREFIX}${userId}`),
				gt(verifications.expiresAt, new Date(now)),
			),
		)
		.get();
	return row?.value;
}

async function verifiedElsewhere(db: Db, e164: string, userId: string): Promise<boolean> {
	const row = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.phoneE164, e164), ne(users.id, userId)))
		.get();
	return row !== undefined;
}

async function clearPending(db: Db, userId: string): Promise<void> {
	await db.delete(verifications).where(eq(verifications.identifier, `${PENDING_PREFIX}${userId}`));
}

export async function startPhoneVerification(
	deps: FlowDeps & { readonly rawPhone: unknown },
): Promise<PhoneResult> {
	const { db, verifier, userId, now } = deps;
	if (!verifier.available) return failure("form", UNAVAILABLE);
	const phone = normalizePhone(deps.rawPhone);
	if (!phone.ok) return failure("phone", phone.message);
	if (await verifiedElsewhere(db, phone.value, userId)) return failure("phone", TAKEN);
	// Both counters move on every attempt, so neither an account nor a number can be used to spam.
	const userOk = await consume(db, `phone-send:user:${userId}`, SEND_LIMIT, now);
	const numberOk = await consume(db, `phone-send:number:${phone.value}`, SEND_LIMIT, now);
	if (!userOk || !numberOk) return failure("form", SLOW_DOWN);

	switch (await verifier.start(phone.value)) {
		case "sent":
			break;
		case "invalid_number":
			return failure("phone", "We can't send a code to that number. Check it and try again.");
		case "line_type":
			return failure("phone", "Use a mobile number. Internet (VoIP) and landline numbers can't verify.");
		case "too_many":
			return failure("form", SLOW_DOWN);
		case "unavailable":
			return failure("form", UNAVAILABLE);
	}
	const at = new Date(now);
	await clearPending(db, userId);
	await db.insert(verifications).values({
		id: uuidv7(),
		identifier: `${PENDING_PREFIX}${userId}`,
		value: phone.value,
		expiresAt: new Date(now + CODE_TTL_MS),
		createdAt: at,
		updatedAt: at,
	});
	return { ok: true, masked: maskPhoneForOwner(phone.value) };
}

export async function checkPhoneVerification(
	deps: FlowDeps & { readonly rawCode: unknown },
): Promise<PhoneResult> {
	const { db, verifier, userId, now } = deps;
	if (!verifier.available) return failure("form", UNAVAILABLE);
	const code = validatePhoneCode(deps.rawCode);
	if (!code.ok) return failure("code", code.message);
	const phone = await pendingPhone(db, userId, now);
	if (!phone) return failure("form", "That code has expired. Ask for a new one.");
	if (!(await consume(db, `phone-check:user:${userId}`, CHECK_LIMIT, now))) {
		return failure("form", "Too many tries. Wait 10 minutes, then ask for a new code.");
	}

	switch (await verifier.check(phone, code.value)) {
		case "approved":
			break;
		case "wrong":
			return failure("code", "That code isn't right. Check the text and try again.");
		case "expired":
			await clearPending(db, userId);
			return failure("form", "That code has expired. Ask for a new one.");
		case "too_many":
			return failure("form", "Too many tries. Wait 10 minutes, then ask for a new code.");
		case "unavailable":
			return failure("form", UNAVAILABLE);
	}
	try {
		await db
			.update(users)
			.set({ phoneE164: phone, phoneVerifiedAt: new Date(now), updatedAt: new Date(now) })
			.where(eq(users.id, userId));
	} catch (error) {
		// Another account verified the same number between our send and this check.
		if (isUniqueViolation(error)) return failure("form", TAKEN);
		throw error;
	}
	await clearPending(db, userId);
	return { ok: true, masked: maskPhoneForOwner(phone) };
}

/** Cancels a pending verification ("use a different number"). */
export async function cancelPhoneVerification(db: Db, userId: string): Promise<void> {
	await clearPending(db, userId);
}
