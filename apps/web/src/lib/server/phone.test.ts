import { createDb, eq, type Db } from "@claimsale/db";
import { users } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import {
	CHECK_LIMIT,
	SEND_LIMIT,
	cancelPhoneVerification,
	checkPhoneVerification,
	pendingPhone,
	startPhoneVerification,
} from "./phone.ts";
import { CODE_TTL_MS, makePhoneVerifier, type PhoneVerifier } from "./sms.ts";

let db: Db;
let clock: number;
let verifier: PhoneVerifier;
const created = new Date("2026-11-01T00:00:00Z");

async function addUser(id: string) {
	await db.insert(users).values({
		id,
		email: `${id}@example.test`,
		displayName: id,
		createdAt: created,
		updatedAt: created,
	});
}

const start = (userId: string, rawPhone: unknown) =>
	startPhoneVerification({ db, verifier, userId, rawPhone, now: clock });
const check = (userId: string, rawCode: unknown) =>
	checkPhoneVerification({ db, verifier, userId, rawCode, now: clock });
const phoneOf = async (id: string) =>
	db.select({ e164: users.phoneE164, at: users.phoneVerifiedAt }).from(users).where(eq(users.id, id)).get();

beforeEach(async () => {
	db = createDb(testD1());
	clock = created.getTime() + 1000;
	verifier = makePhoneVerifier({
		mode: "capture",
		db,
		now: () => clock,
		code: () => "424242",
		log: () => {},
	});
	await addUser("u1");
	await addUser("u2");
});

describe("phone verification", () => {
	it("[AUTH-phone-e164] sends a code to the E.164 number and stores it only after the right code", async () => {
		expect(await start("u1", "(202) 555-0123")).toEqual({ ok: true, masked: "+1 ••• 0123" });
		expect(await pendingPhone(db, "u1", clock)).toBe("+12025550123");
		expect((await phoneOf("u1"))?.e164).toBeNull();

		expect(await check("u1", "000000")).toEqual({
			ok: false,
			field: "code",
			message: "That code isn't right. Check the text and try again.",
		});
		expect(await check("u1", "424 242")).toEqual({ ok: true, masked: "+1 ••• 0123" });
		expect(await phoneOf("u1")).toEqual({ e164: "+12025550123", at: new Date(clock) });
		expect(await pendingPhone(db, "u1", clock)).toBeUndefined();
	});

	it("[AUTH-phone-e164] one number can't verify two accounts", async () => {
		await start("u1", "+12025550123");
		await check("u1", "424242");
		expect(await start("u2", "202-555-0123")).toEqual({
			ok: false,
			field: "phone",
			message: "This number is already verified on another account.",
		});
		// Re-verifying your own number is fine.
		expect((await start("u1", "+12025550123")).ok).toBe(true);
	});

	it("[AUTH-phone-e164] a race between two accounts on one number ends with one owner", async () => {
		verifier = { mode: "twilio", available: true, start: async () => "sent", check: async () => "approved" };
		await start("u1", "+12025550123");
		await start("u2", "+12025550123");
		expect((await check("u1", "424242")).ok).toBe(true);
		expect(await check("u2", "424242")).toEqual({
			ok: false,
			field: "form",
			message: "This number is already verified on another account.",
		});
		expect((await phoneOf("u2"))?.e164).toBeNull();
	});

	it("rejects malformed numbers and codes before sending or checking", async () => {
		const send = vi.spyOn(verifier, "start");
		expect(await start("u1", "12345")).toMatchObject({ ok: false, field: "phone" });
		expect(send).not.toHaveBeenCalled();
		expect(await check("u1", "12")).toMatchObject({ ok: false, field: "code" });
		expect(await check("u1", "424242")).toEqual({
			ok: false,
			field: "form",
			message: "That code has expired. Ask for a new one.",
		});
	});

	it("expires the pending number with the code, and can be cancelled", async () => {
		await start("u1", "+12025550123");
		clock += CODE_TTL_MS;
		expect(await pendingPhone(db, "u1", clock)).toBeUndefined();
		expect(await check("u1", "424242")).toMatchObject({ ok: false, field: "form" });

		await start("u1", "+12025550123");
		await cancelPhoneVerification(db, "u1");
		expect(await pendingPhone(db, "u1", clock)).toBeUndefined();
	});

	it("[AUTH-phone-otp-limit] limits sends per account and per number", async () => {
		for (let i = 0; i < SEND_LIMIT.max; i++) {
			// oxlint-disable-next-line no-await-in-loop -- attempts are sequential on purpose
			expect((await start("u1", `+1202555010${i}`)).ok).toBe(true);
		}
		expect(await start("u1", "+12025550199")).toEqual({
			ok: false,
			field: "form",
			message: "Too many codes. Wait an hour and try again.",
		});
		// Another account can't keep texting a number that has had its share either.
		await addUser("u3");
		for (let i = 0; i < SEND_LIMIT.max - 1; i++) {
			// oxlint-disable-next-line no-await-in-loop -- attempts are sequential on purpose
			await start("u3", "+12025550100");
		}
		expect(await start("u2", "+12025550100")).toMatchObject({ ok: false, field: "form" });
		clock += SEND_LIMIT.windowMs;
		expect((await start("u1", "+12025550199")).ok).toBe(true);
	});

	it("[AUTH-phone-otp-limit] limits code checks per account", async () => {
		await start("u1", "+12025550123");
		for (let i = 0; i < CHECK_LIMIT.max; i++) {
			// oxlint-disable-next-line no-await-in-loop -- attempts are sequential on purpose
			expect(await check("u1", "000000")).toMatchObject({ field: "code" });
		}
		expect(await check("u1", "424242")).toEqual({
			ok: false,
			field: "form",
			message: "Too many tries. Wait 10 minutes, then ask for a new code.",
		});
		expect((await phoneOf("u1"))?.e164).toBeNull();
	});

	it("explains what the verifier reports", async () => {
		const outcomes: Array<[Awaited<ReturnType<PhoneVerifier["start"]>>, string]> = [
			["invalid_number", "We can't send a code to that number. Check it and try again."],
			["line_type", "Use a mobile number. Internet (VoIP) and landline numbers can't verify."],
			["too_many", "Too many codes. Wait an hour and try again."],
			["unavailable", "Phone verification isn't available right now. Try again later."],
		];
		for (const [outcome, message] of outcomes) {
			verifier = { mode: "twilio", available: true, start: async () => outcome, check: async () => "wrong" };
			// oxlint-disable-next-line no-await-in-loop -- one verifier at a time
			expect((await start("u1", "+447700900123")) as { message?: string }).toMatchObject({ message });
		}
		expect(await pendingPhone(db, "u1", clock)).toBeUndefined();

		verifier = { mode: "twilio", available: true, start: async () => "sent", check: async () => "expired" };
		await start("u1", "+447700900123");
		expect(await check("u1", "123456")).toMatchObject({
			message: "That code has expired. Ask for a new one.",
		});
		expect(await pendingPhone(db, "u1", clock)).toBeUndefined();

		for (const [outcome, field] of [
			["too_many", "form"],
			["unavailable", "form"],
		] as const) {
			verifier = { mode: "twilio", available: true, start: async () => "sent", check: async () => outcome };
			// oxlint-disable-next-line no-await-in-loop -- one verifier at a time
			await start("u2", "+447700900124");
			// oxlint-disable-next-line no-await-in-loop -- one verifier at a time
			expect(await check("u2", "123456")).toMatchObject({ ok: false, field });
		}
	});

	it("says so when phone verification isn't configured", async () => {
		verifier = makePhoneVerifier({ mode: "twilio", db });
		const message = "Phone verification isn't available right now. Try again later.";
		expect(await start("u1", "+12025550123")).toEqual({ ok: false, field: "form", message });
		expect(await check("u1", "123456")).toEqual({ ok: false, field: "form", message });
	});
});
