import { createDb, eq, type Db } from "@claimsale/db";
import { accountFlags } from "@claimsale/db/photos";
import { auditLog, entries, items, reports, rescinds, sales, sessions, users } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { openFlags } from "./admin.ts";
import { entitlements } from "./entitlements.ts";
import {
	banUser,
	closeReport,
	fileReport,
	findUsers,
	grantPro,
	openReports,
	overturnedFlags,
	rescindQueue,
	revokePro,
	unbanUser,
	userDetail,
} from "./moderation.ts";
import {
	answerAsBuyer,
	buyerRescinds,
	contestAsBuyer,
	resolveDispute,
	type RescindEngine,
} from "./rescinds.ts";

const T = 1_800_000_000_000;
const DAY = 86_400_000;
let db: Db;

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "admin");
	await db.update(users).set({ role: "admin" }).where(eq(users.id, "admin"));
	await addUser(db, "ash", { handle: "ash_k", email: "ash@example.test" });
	await addUser(db, "misty");
});

const audits = () => db.select().from(auditLog).all();

describe("bans", () => {
	it("[ADMIN-ban] bans with a reason, ends the sessions, logs it, and unbans", async () => {
		await db.insert(sessions).values({
			id: "sess",
			userId: "ash",
			token: "tok",
			expiresAt: new Date(T + DAY),
			createdAt: new Date(T),
			updatedAt: new Date(T),
		});
		expect(await banUser(db, { userId: "ash", adminId: "admin", reason: "x" }, T)).toMatchObject({
			ok: false,
			error: { code: "invalid_reason" },
		});
		expect(await banUser(db, { userId: "ash", adminId: "admin", reason: " Sold proxies " }, T)).toEqual({
			ok: true,
			value: true,
		});
		const row = await db.select().from(users).where(eq(users.id, "ash")).get();
		expect(row).toMatchObject({ bannedReason: "Sold proxies", bannedBy: "admin" });
		expect(row?.bannedAt?.getTime()).toBe(T);
		expect(await db.select().from(sessions).all()).toEqual([]);
		expect(await banUser(db, { userId: "ash", adminId: "admin", reason: "again" }, T)).toMatchObject({
			ok: false,
			error: { code: "already_banned" },
		});
		expect(await unbanUser(db, { userId: "ash", adminId: "admin" }, T + 1)).toEqual({
			ok: true,
			value: true,
		});
		expect(await unbanUser(db, { userId: "ash", adminId: "admin" }, T + 1)).toMatchObject({ ok: false });
		expect((await db.select().from(users).where(eq(users.id, "ash")).get())?.bannedAt).toBeNull();
		// Audit rows carry IDs only, never the email.
		const log = await audits();
		expect(log.map((a) => [a.action, a.actorId, a.saleId])).toEqual([
			["admin_ban", "admin", null],
			["admin_unban", "admin", null],
		]);
		expect(JSON.stringify(log)).not.toContain("@example.test");
	});

	it("[ADMIN-ban] refuses admins and unknown accounts", async () => {
		expect(await banUser(db, { userId: "admin", adminId: "admin", reason: "oops" }, T)).toMatchObject({
			ok: false,
			error: { code: "not_allowed" },
		});
		expect(await banUser(db, { userId: "nobody", adminId: "admin", reason: "who" }, T)).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});
});

describe("Pro grants", () => {
	it("[ADMIN-pro-grant] grants, extends and revokes Pro; tiers follow at once", async () => {
		expect(await entitlements(db, "ash", T)).toEqual({ seller: "free", buyer: "free" });
		expect(
			await grantPro(db, { userId: "ash", adminId: "admin", planId: "gold", until: null }, T),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_plan" },
		});
		expect(
			await grantPro(db, { userId: "ash", adminId: "admin", planId: "bundle", until: T - 1 }, T),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_until" },
		});
		expect(
			await grantPro(db, { userId: "nobody", adminId: "admin", planId: "bundle", until: null }, T),
		).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		await grantPro(db, { userId: "ash", adminId: "admin", planId: "seller_pro", until: T + DAY }, T);
		expect(await entitlements(db, "ash", T)).toEqual({ seller: "pro", buyer: "free" });
		expect(await entitlements(db, "ash", T + DAY + 1)).toEqual({ seller: "free", buyer: "free" });
		// Granting again replaces the end date.
		await grantPro(db, { userId: "ash", adminId: "admin", planId: "seller_pro", until: null }, T);
		expect(await entitlements(db, "ash", T + 30 * DAY)).toEqual({ seller: "pro", buyer: "free" });
		expect((await userDetail(db, "ash"))?.grants).toEqual([
			{ planId: "seller_pro", planName: expect.any(String), status: "granted", currentPeriodEnd: null },
		]);

		expect(await revokePro(db, { userId: "ash", adminId: "admin", planId: "seller_pro" }, T + 1)).toEqual({
			ok: true,
			value: true,
		});
		expect(await entitlements(db, "ash", T + 2)).toEqual({ seller: "free", buyer: "free" });
		expect(
			await revokePro(db, { userId: "ash", adminId: "admin", planId: "seller_pro" }, T + 1),
		).toMatchObject({
			ok: false,
			error: { code: "not_granted" },
		});
		expect((await audits()).map((a) => a.action)).toEqual([
			"admin_pro_grant",
			"admin_pro_grant",
			"admin_pro_revoke",
		]);
	});
});

describe("finding accounts", () => {
	it("finds by handle prefix or exact email; LIKE wildcards are literal", async () => {
		expect((await findUsers(db, "@ash")).map((u) => u.id)).toEqual(["ash"]);
		expect((await findUsers(db, "ASH@example.test")).map((u) => u.id)).toEqual(["ash"]);
		expect(await findUsers(db, "a")).toEqual([]);
		expect(await findUsers(db, "%_")).toEqual([]);
		expect(await userDetail(db, "nobody")).toBeNull();
	});
});

async function saleWithItem() {
	await db.insert(sales).values({
		id: "s1",
		sellerId: "misty",
		slug: "s1",
		title: "Sale",
		status: "live",
		createdAt: T,
		updatedAt: T,
	});
	await db.insert(items).values({
		id: "i1",
		saleId: "s1",
		sortOrder: 0,
		gameId: "pokemon",
		title: "Charizard",
		priceCents: 4000,
		createdAt: T,
		updatedAt: T,
	});
}

describe("reports", () => {
	it("[ADMIN-report-queue] files one open report per reporter and target, and the admin closes it", async () => {
		await saleWithItem();
		const report = {
			targetKind: "sale",
			targetId: "s1",
			reason: "counterfeit",
			details: " Proxies in photos ",
		};
		const filed = await fileReport(db, "ash", report, T);
		expect(filed).toMatchObject({ ok: true, value: { id: expect.any(String) } });
		expect(await fileReport(db, "ash", report, T)).toMatchObject({
			ok: false,
			error: { code: "already_reported" },
		});
		await fileReport(db, "admin", { targetKind: "sale", targetId: "s1", reason: "scam" }, T + 1);
		const queue = await openReports(db);
		expect(queue).toHaveLength(2);
		expect(queue[0]).toMatchObject({ reporterHandle: "ash_k", details: "Proxies in photos", sameTarget: 2 });

		const id = filed.ok ? filed.value.id : "";
		expect(
			await closeReport(
				db,
				{ reportId: id, adminId: "admin", status: "dismissed", note: "Real photos" },
				T + 2,
			),
		).toEqual({
			ok: true,
			value: true,
		});
		expect(
			await closeReport(db, { reportId: id, adminId: "admin", status: "resolved", note: "" }, T + 2),
		).toMatchObject({
			ok: false,
		});
		expect(await db.select().from(reports).where(eq(reports.id, id)).get()).toMatchObject({
			status: "dismissed",
			resolutionNote: "Real photos",
			resolvedBy: "admin",
		});
		// Once closed, the same reporter can report it again.
		expect((await fileReport(db, "ash", report, T + 3)).ok).toBe(true);
	});

	it("[ADMIN-report-queue] checks the target and the input, and limits reports per hour", async () => {
		await saleWithItem();
		const bad = [
			[null, "invalid_input"],
			[{ targetKind: "planet", targetId: "x", reason: "scam" }, "invalid_input"],
			[{ targetKind: "user", targetId: "misty", reason: "rude" }, "invalid_input"],
			[{ targetKind: "user", targetId: "ash", reason: "scam" }, "invalid_input"],
			[{ targetKind: "user", targetId: "misty", reason: "scam", details: "x".repeat(2001) }, "invalid_input"],
			[{ targetKind: "user", targetId: "nobody", reason: "scam" }, "not_found"],
			[{ targetKind: "item", targetId: "nope", reason: "scam" }, "not_found"],
		] as const;
		for (const [body, code] of bad) {
			expect(await fileReport(db, "ash", body, T)).toMatchObject({ ok: false, error: { code } });
		}
		expect(
			(await fileReport(db, "ash", { targetKind: "item", targetId: "i1", reason: "stolen_photo" }, T)).ok,
		).toBe(true);
		expect(
			(await fileReport(db, "ash", { targetKind: "message", targetId: "m1", reason: "harassment" }, T)).ok,
		).toBe(true);
		for (let i = 0; i < 20; i++)
			await fileReport(db, "misty", { targetKind: "message", targetId: `m${i}`, reason: "other" }, T);
		expect(
			await fileReport(db, "misty", { targetKind: "message", targetId: "m99", reason: "other" }, T),
		).toMatchObject({
			ok: false,
			error: { code: "rate_limited" },
		});
	});
});

/** A rescind of one of ash's wins in misty's sale (needs saleWithItem first). */
async function rescind(id: string, over: Partial<typeof rescinds.$inferInsert>) {
	{
		await db.insert(entries).values({
			id: `e-${id}`,
			itemId: "i1",
			userId: "ash",
			kind: "claim",
			amountCents: 4000,
			status: "rescinded",
			createdAt: T,
		});
		await db.insert(rescinds).values({
			id,
			entryId: `e-${id}`,
			sellerId: "misty",
			buyerId: "ash",
			reasonCode: "buyer_nonpayment",
			explanation: "Never paid the invoice at all",
			fault: "buyer",
			createdAt: T,
			...over,
		});
	}
}

describe("rescind disputes", () => {
	it("[SM-4.3.1-contest] queues contested, disputed and held rescinds, including rows from before the phase column", async () => {
		await saleWithItem();
		await rescind("final", { phase: "final" });
		await rescind("contested", { phase: "contested", contestedAt: T + 1, contestText: "I paid on day one" });
		await rescind("fraud", {
			phase: "admin_review",
			reasonCode: "suspected_fraud",
			fault: "review",
			createdAt: T + 1,
		});
		await rescind("legacy-contested", { contestedAt: T + 2, createdAt: T + 2 });
		await rescind("legacy-resolved", { contestedAt: T + 2, resolvedAt: T + 3, resolvedFault: "seller" });
		await rescind("waiting", { phase: "awaiting_buyer", reasonCode: "mutual_agreement", fault: "neutral" });
		const queue = await rescindQueue(db);
		expect(queue.map((r) => [r.id, r.phase])).toEqual([
			["contested", "contested"],
			["fraud", "admin_review"],
			["legacy-contested", "contested"],
		]);
		expect(queue[0]).toMatchObject({
			sellerHandle: "misty",
			buyerHandle: "ash_k",
			contestText: "I paid on day one",
			saleTitle: "Sale",
		});
	});

	it("[SM-4.3.1-abuse-guard] lists sellers the abuse guard flagged, apart from the photo flags", async () => {
		await db.insert(accountFlags).values([
			{ id: "f1", userId: "misty", reason: "overturned_rescinds", count: 3, createdAt: T },
			{ id: "f2", userId: "ash", reason: "repeat_photo_rejections", count: 3, createdAt: T },
		]);
		expect((await overturnedFlags(db)).map((f) => [f.flagId, f.count])).toEqual([["f1", 3]]);
		expect((await openFlags(db)).map((f) => f.flagId)).toEqual(["f2"]);
	});

	it("[SM-4.3.1-contest] the buyer sees their rescinds with what they can still do", async () => {
		await saleWithItem();
		await rescind("old", { phase: "final", createdAt: T - 8 * DAY });
		await rescind("recent", { phase: "final" });
		await rescind("mutual", {
			phase: "awaiting_buyer",
			reasonCode: "mutual_agreement",
			fault: "neutral",
			createdAt: T + 1,
		});
		const list = await buyerRescinds(db, "ash", T + DAY);
		expect(list.map((r) => [r.id, r.contestUntil, r.answerBy])).toEqual([
			["mutual", null, T + 1 + 3 * DAY],
			["recent", T + 7 * DAY, null],
			["old", null, null],
		]);
		expect(await buyerRescinds(db, "misty", T)).toEqual([]);
	});

	it("[SM-4.3.1-mutual] calls the engine for the rescind's own buyer only, with its sale", async () => {
		await saleWithItem();
		await rescind("r1", { phase: "final" });
		const call = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
			ok: true,
			value: { ok: true, value: {} },
		}));
		const engine = {
			contestRescind: call,
			answerMutualRescind: call,
			resolveRescind: call,
		} as unknown as RescindEngine;
		expect(
			await contestAsBuyer(db, engine, { rescindId: "r1", buyerId: "misty", text: "Not mine at all" }),
		).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(
			await contestAsBuyer(db, engine, { rescindId: "r1", buyerId: "ash", text: "I paid on time" }),
		).toEqual({
			ok: true,
			value: true,
		});
		await answerAsBuyer(db, engine, { rescindId: "r1", buyerId: "ash", agree: false });
		expect(await answerAsBuyer(db, engine, { rescindId: "zz", buyerId: "ash", agree: true })).toMatchObject({
			ok: false,
		});
		expect(call.mock.calls.map(([input]) => input)).toEqual([
			{ saleId: "s1", rescindId: "r1", buyerId: "ash", text: "I paid on time" },
			{ saleId: "s1", rescindId: "r1", buyerId: "ash", agree: false },
		]);
	});

	it("[SM-4.3.1-contest] the admin's resolution goes to the rescind's engine; rejections and defects come back", async () => {
		await saleWithItem();
		await rescind("r1", { phase: "contested", contestedAt: T });
		const answers = [
			{ ok: true, value: { ok: true, value: {} } },
			{ ok: true, value: { ok: false, error: { code: "invalid_phase", message: "Nothing to resolve" } } },
			{ ok: false, error: { name: "Error", message: "boom" } },
		];
		const call = vi.fn<(input: unknown) => Promise<unknown>>(async () => answers.shift());
		const engine = { resolveRescind: call } as unknown as RescindEngine;
		const input = { rescindId: "r1", adminId: "admin", fault: "seller", note: " Paid " };
		expect(await resolveDispute(db, engine, { ...input, fault: "review" })).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(await resolveDispute(db, engine, { ...input, rescindId: "zz" })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(await resolveDispute(db, engine, input)).toEqual({ ok: true, value: true });
		expect(call).toHaveBeenCalledWith({
			saleId: "s1",
			rescindId: "r1",
			adminId: "admin",
			fault: "seller",
			note: "Paid",
		});
		expect(await resolveDispute(db, engine, input)).toMatchObject({
			ok: false,
			error: { code: "invalid_phase" },
		});
		expect(await resolveDispute(db, engine, input)).toMatchObject({
			ok: false,
			error: { code: "engine_unavailable" },
		});
		const throwing = {
			resolveRescind: async () => Promise.reject(new Error("down")),
		} as unknown as RescindEngine;
		expect(await resolveDispute(db, throwing, input)).toMatchObject({
			ok: false,
			error: { code: "engine_unavailable" },
		});
	});

	it("[REP-buyer-record] the admin sees the buyer record and the seller's final seller-fault cancels", async () => {
		await saleWithItem();
		await rescind("a", { phase: "final" });
		await rescind("b", {
			phase: "final",
			reasonCode: "seller_listing_error",
			fault: "seller",
			buyerId: "ash",
		});
		await rescind("c", {
			phase: "contested",
			reasonCode: "seller_item_unavailable",
			fault: "seller",
			contestedAt: T,
		});
		await rescind("d", { phase: "final", contestedAt: T, resolvedAt: T, resolvedFault: "seller" });
		const misty = await userDetail(db, "misty");
		expect(misty?.sellerCancels).toBe(2);
		const ash = await userDetail(db, "ash");
		expect(ash?.record?.record).toMatchObject({ nonPay: 1 });
		expect(ash?.user).toMatchObject({ handle: "ash_k", bannedAt: null, role: "user" });
	});
});
