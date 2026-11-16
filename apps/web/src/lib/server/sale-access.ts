import { saleAccess as decideAccess, type Millis, type SaleAccess, type SaleGate } from "@claimsale/core";
import { eq, type Db } from "@claimsale/db";
import { rateLimits } from "@claimsale/db/schema";
import { isAllowlisted } from "./sales.ts";

/**
 * Private-sale access (D5): password hashes, the per-browser unlock cookie and
 * guessing limits. The decision itself is `saleAccess` in packages/core.
 */

const ITERATIONS = 100_000; // the most PBKDF2 iterations Workers allow
const encoder = new TextEncoder();

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pbkdf2(
	password: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number,
): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export const SALE_PASSWORD_MIN = 4;
export const SALE_PASSWORD_MAX = 100;

/** `pbkdf2$<iterations>$<salt>$<hash>`, all base64. */
export async function hashSalePassword(password: string, iterations = ITERATIONS): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

export async function verifySalePassword(password: string, stored: string): Promise<boolean> {
	const [scheme, iterations, salt, hash] = stored.split("$");
	if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
	const actual = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iterations)));
	const expected = unb64(hash);
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
	return diff === 0;
}

// ---------------------------------------------------------------------------
// Unlock cookie: an HMAC over the sale and its current password hash, so changing
// the password locks every browser out again.

export const unlockCookieName = (saleId: string) => `cs_sale_${saleId.replaceAll("-", "")}`;

async function hmac(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
	return b64(sig).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function unlockToken(secret: string, saleId: string, passwordHash: string): Promise<string> {
	return hmac(secret, `sale-unlock:${saleId}:${passwordHash}`);
}

export async function isUnlocked(
	secret: string,
	saleId: string,
	passwordHash: string | null,
	cookie: string | undefined,
): Promise<boolean> {
	if (!passwordHash || !cookie) return false;
	return cookie === (await unlockToken(secret, saleId, passwordHash));
}

// ---------------------------------------------------------------------------
// Guessing limit: a fixed window per sale and client, stored in D1 (isolates share no memory).

export const UNLOCK_ATTEMPTS = 10;
export const UNLOCK_WINDOW: Millis = 15 * 60_000;

/** Records an attempt; false when the client has used up its attempts in this window. */
export async function allowUnlockAttempt(
	db: Db,
	saleId: string,
	client: string,
	now: Millis,
): Promise<boolean> {
	const key = `sale-unlock:${saleId}:${client}`;
	const row = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
	if (!row || now - row.lastRequest > UNLOCK_WINDOW) {
		await db
			.insert(rateLimits)
			.values({ id: key, key, count: 1, lastRequest: now })
			.onConflictDoUpdate({ target: rateLimits.key, set: { count: 1, lastRequest: now } });
		return true;
	}
	if (row.count >= UNLOCK_ATTEMPTS) return false;
	await db
		.update(rateLimits)
		.set({ count: row.count + 1 })
		.where(eq(rateLimits.key, key));
	return true;
}

// ---------------------------------------------------------------------------

export interface AccessViewer {
	readonly user: { id: string; email: string; emailVerified: boolean } | null;
	readonly unlockCookie: string | undefined;
}

/**
 * Decides access for a viewer, reading the allowlist only when it matters.
 *
 * @spec SM-2-visibility
 */
export async function accessFor(
	db: Db,
	secret: string,
	sale: SaleGate & { id: string; passwordHash: string | null },
	viewer: AccessViewer,
): Promise<SaleAccess> {
	const base = { userId: viewer.user?.id ?? null, passwordUnlocked: false, allowlisted: false };
	const first = decideAccess(sale, base);
	if (first !== "locked") return first;
	const passwordUnlocked = await isUnlocked(secret, sale.id, sale.passwordHash, viewer.unlockCookie);
	const allowlisted =
		!passwordUnlocked && sale.allowlistEnabled && (await isAllowlisted(db, sale.id, viewer.user));
	return decideAccess(sale, { ...base, passwordUnlocked, allowlisted });
}
