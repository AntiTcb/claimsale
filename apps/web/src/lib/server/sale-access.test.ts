import { createDb, type Db } from "@claimsale/db";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import {
	accessFor,
	allowUnlockAttempt,
	hashSalePassword,
	isUnlocked,
	UNLOCK_ATTEMPTS,
	UNLOCK_WINDOW,
	unlockCookieName,
	unlockToken,
	verifySalePassword,
} from "./sale-access.ts";
import { createDraft, setPrivateAccess } from "./sales.ts";

const SECRET = "test-secret-at-least-32-characters-long";
const user = (id: string, email: string, emailVerified = true) => ({ id, email, emailVerified });

describe("sale passwords", () => {
	it("hashes with a salt and verifies only the right password", async () => {
		const a = await hashSalePassword("pikachu", 1000);
		const b = await hashSalePassword("pikachu", 1000);
		expect(a).toMatch(/^pbkdf2\$1000\$/);
		expect(a).not.toBe(b);
		expect(await verifySalePassword("pikachu", a)).toBe(true);
		expect(await verifySalePassword("Pikachu", a)).toBe(false);
		expect(await verifySalePassword("pikachu", "plain")).toBe(false);
	});

	it("unlock cookies are tied to the sale and its current password", async () => {
		const token = await unlockToken(SECRET, "sale-1", "hash-1");
		expect(await isUnlocked(SECRET, "sale-1", "hash-1", token)).toBe(true);
		expect(await isUnlocked(SECRET, "sale-2", "hash-1", token)).toBe(false);
		expect(await isUnlocked(SECRET, "sale-1", "hash-2", token)).toBe(false);
		expect(await isUnlocked("another-secret", "sale-1", "hash-1", token)).toBe(false);
		expect(await isUnlocked(SECRET, "sale-1", null, token)).toBe(false);
		expect(await isUnlocked(SECRET, "sale-1", "hash-1", undefined)).toBe(false);
		expect(unlockCookieName("0190-ab")).toBe("cs_sale_0190ab");
	});
});

describe("private sale access", () => {
	let db: Db;
	beforeEach(async () => {
		db = createDb(testD1());
		await addUser(db, "seller");
		await addUser(db, "invited", { email: "invited@example.test" });
		await addUser(db, "unverified", { email: "unverified@example.test", emailVerified: false });
	});

	it("limits password guesses per sale and client, per window", async () => {
		for (let i = 0; i < UNLOCK_ATTEMPTS; i++)
			expect(await allowUnlockAttempt(db, "s1", "1.2.3.4", 1000 + i)).toBe(true);
		expect(await allowUnlockAttempt(db, "s1", "1.2.3.4", 2000)).toBe(false);
		expect(await allowUnlockAttempt(db, "s1", "5.6.7.8", 2000)).toBe(true);
		expect(await allowUnlockAttempt(db, "s2", "1.2.3.4", 2000)).toBe(true);
		expect(await allowUnlockAttempt(db, "s1", "1.2.3.4", 1000 + UNLOCK_WINDOW + 1)).toBe(true);
	});

	it("[SM-2-visibility] lets in the seller, an unlocked browser and a verified invitee; locks everyone else", async () => {
		const created = await createDraft(
			db,
			{ id: "seller", tier: "pro" },
			{ title: "VIP", descriptionMd: "", visibility: "private" },
			1,
		);
		if (!created.ok) throw new Error("setup");
		const passwordHash = await hashSalePassword("secret", 1000);
		await setPrivateAccess(
			db,
			created.value.id,
			{ passwordHash, allowlist: ["invited@example.test", "unverified@example.test"] },
			2,
		);
		const sale = {
			id: created.value.id,
			sellerId: "seller",
			status: "scheduled" as const,
			visibility: "private" as const,
			hasPassword: true,
			allowlistEnabled: true,
			passwordHash,
		};
		expect(await accessFor(db, SECRET, sale, { user: null, unlockCookie: undefined })).toBe("locked");
		expect(
			await accessFor(db, SECRET, sale, {
				user: user("seller", "seller@example.test"),
				unlockCookie: undefined,
			}),
		).toBe("ok");
		const cookie = await unlockToken(SECRET, sale.id, passwordHash);
		expect(await accessFor(db, SECRET, sale, { user: null, unlockCookie: cookie })).toBe("ok");
		expect(await accessFor(db, SECRET, sale, { user: null, unlockCookie: "forged" })).toBe("locked");
		expect(
			await accessFor(db, SECRET, sale, {
				user: user("invited", "INVITED@example.test"),
				unlockCookie: undefined,
			}),
		).toBe("ok");
		expect(
			await accessFor(db, SECRET, sale, {
				user: user("unverified", "unverified@example.test", false),
				unlockCookie: undefined,
			}),
		).toBe("locked");
		expect(
			await accessFor(db, SECRET, { ...sale, status: "draft" }, { user: null, unlockCookie: cookie }),
		).toBe("not_found");
	});
});
