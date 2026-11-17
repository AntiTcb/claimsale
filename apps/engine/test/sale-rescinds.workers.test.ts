import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RescindReasonCode } from "@claimsale/core";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTimers } from "../src/sale/timers.ts";
import { sweepTimers } from "../src/sale/sweep.ts";
import {
	addUser,
	auditOf,
	claim,
	DAY,
	db,
	engine,
	entryOf,
	HOUR,
	makeSale,
	rejection,
	saleRow,
	setClock,
	stubFor,
	uid,
	value,
	type SaleSetup,
} from "./sale-fixtures.ts";

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	quiet = [vi.spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

const alarmOf = (saleId: string) =>
	runInDurableObject(stubFor(saleId), (_instance, state) => state.storage.getAlarm());

interface RescindRow {
	id: string;
	phase: string | null;
	fault: string;
	contested_at: number | null;
	contest_text: string | null;
	answered_at: number | null;
	resolved_fault: string | null;
	resolved_by: string | null;
	resolved_at: number | null;
	resolution_note: string | null;
}

const rescindOf = async (entryId: string) =>
	(await db.prepare("SELECT * FROM rescinds WHERE entry_id = ?1").bind(entryId).first<RescindRow>())!;

async function addAdmin() {
	const id = await addUser(uid("admin"));
	await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?1").bind(id).run();
	return id;
}

/** A buyer wins the sale's first item and the seller rescinds it with `reasonCode`. */
async function rescinded(reasonCode: RescindReasonCode, sale?: SaleSetup) {
	const s = sale ?? (await makeSale({ closesAt: Date.now() + 10 * DAY }));
	const buyer = await addUser();
	const entry = entryOf(await claim(s, buyer));
	value(
		await engine.sellerRescind({
			saleId: s.saleId,
			itemId: s.itemIds[0]!,
			entryId: entry.id,
			sellerId: s.sellerId,
			reasonCode,
			explanation: "Explaining what happened in enough words",
			passToNext: false,
			confirmed: false,
		}),
	);
	const row = await rescindOf(entry.id);
	return { sale: s, buyer, entryId: entry.id, rescindId: row.id, row };
}

describe("rescind contests", () => {
	it("the buyer contests within 7 days with their side; the attribution is frozen [SM-4.3.1-contest]", async () => {
		const { sale, buyer, entryId, rescindId, row } = await rescinded("buyer_nonpayment");
		expect(row).toMatchObject({ phase: "final", fault: "buyer", contested_at: null });
		const base = { saleId: sale.saleId, rescindId, buyerId: buyer };

		expect(rejection(await engine.contestRescind({ ...base, text: "nope" }))).toBe("contest_text_invalid");
		const stranger = await addUser();
		expect(
			rejection(
				await engine.contestRescind({ ...base, buyerId: stranger, text: "I paid on time, honestly" }),
			),
		).toBe("not_allowed");
		expect(rejection(await engine.contestRescind({ ...base, rescindId: "nope", text: "x".repeat(20) }))).toBe(
			"not_found",
		);

		const view = value(
			await engine.contestRescind({ ...base, text: "  I paid on time, here is the ref.  " }),
		);
		expect(view).toMatchObject({ id: rescindId, phase: "contested", fault: "buyer" });
		expect(await rescindOf(entryId)).toMatchObject({
			phase: "contested",
			contest_text: "I paid on time, here is the ref.",
			contested_at: expect.any(Number),
		});
		// One contest only.
		expect(rejection(await engine.contestRescind({ ...base, text: "Trying a second time now" }))).toBe(
			"invalid_phase",
		);
		const audit = (await auditOf(sale.saleId)).find((a) => a.action === "rescind_contested");
		expect(audit).toMatchObject({ actor_id: buyer, data: { input: { rescindId } } });
		// The buyer's words stay in the rescind row, not in the audit log.
		expect(JSON.stringify(audit)).not.toContain("here is the ref");
	});

	it("the contest window closes after 7 days [SM-4.3.1-contest]", async () => {
		const sale = await makeSale({ closesAt: Date.now() + 10 * DAY });
		const t0 = Date.now();
		await setClock(sale.saleId, t0);
		const { buyer, rescindId } = await rescinded("buyer_unresponsive", sale);
		await setClock(sale.saleId, t0 + 7 * DAY + 1);
		expect(
			rejection(
				await engine.contestRescind({
					saleId: sale.saleId,
					rescindId,
					buyerId: buyer,
					text: "Too late but trying anyway",
				}),
			),
		).toBe("contest_window_closed");
	});
});

describe("mutual agreement answers", () => {
	it("waits for the buyer; agreeing makes it final and neutral [SM-4.3.1-mutual]", async () => {
		const { sale, buyer, entryId, rescindId, row } = await rescinded("mutual_agreement");
		expect(row).toMatchObject({ phase: "awaiting_buyer", fault: "neutral" });
		const base = { saleId: sale.saleId, rescindId };
		expect(
			rejection(await engine.answerMutualRescind({ ...base, buyerId: sale.sellerId, agree: true })),
		).toBe("not_allowed");
		expect(value(await engine.answerMutualRescind({ ...base, buyerId: buyer, agree: true }))).toMatchObject({
			phase: "final",
		});
		expect(await rescindOf(entryId)).toMatchObject({ phase: "final", answered_at: expect.any(Number) });
		expect(rejection(await engine.answerMutualRescind({ ...base, buyerId: buyer, agree: false }))).toBe(
			"invalid_phase",
		);
	});

	it("disputing sends it to the admin queue like a contest [SM-4.3.1-mutual]", async () => {
		const { sale, buyer, entryId, rescindId } = await rescinded("mutual_agreement");
		value(await engine.answerMutualRescind({ saleId: sale.saleId, rescindId, buyerId: buyer, agree: false }));
		expect(await rescindOf(entryId)).toMatchObject({
			phase: "contested",
			contested_at: expect.any(Number),
			answered_at: expect.any(Number),
		});
	});

	it("arms the sale's alarm at 72h; no answer by then counts as agreement [SM-4.3.1-mutual] [SM-7-single-alarm]", async () => {
		const sale = await makeSale({ closesAt: Date.now() + 10 * DAY });
		const t0 = Date.now();
		await setClock(sale.saleId, t0);
		const { entryId } = await rescinded("mutual_agreement", sale);
		expect(await alarmOf(sale.saleId)).toBe(t0 + 72 * HOUR);

		// An early alarm does nothing.
		await setClock(sale.saleId, t0 + 71 * HOUR);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect(await rescindOf(entryId)).toMatchObject({ phase: "awaiting_buyer", answered_at: null });

		await setClock(sale.saleId, t0 + 72 * HOUR);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect(await rescindOf(entryId)).toMatchObject({ phase: "final", answered_at: t0 + 72 * HOUR });
		expect((await auditOf(sale.saleId)).map((a) => a.action)).toContain("rescind_mutual_timed_out");
		// Re-armed at the next timer: the sale's close.
		expect(await alarmOf(sale.saleId)).toBe((await saleRow(sale.saleId))["closes_at"]);
	});

	it("the cron sweep answers a mutual agreement whose alarm was lost, including rows from before the phase column [SM-4.3.1-mutual]", async () => {
		const { sale, entryId } = await rescinded("mutual_agreement");
		await runInDurableObject(stubFor(sale.saleId), (_i, state) => state.storage.deleteAlarm());
		// A row written before WS-I: no phase, created more than 72h ago.
		await db
			.prepare("UPDATE rescinds SET phase = NULL, created_at = ?1 WHERE entry_id = ?2")
			.bind(Date.now() - 73 * HOUR, entryId)
			.run();
		expect((await loadTimers(db, sale.saleId, Date.now())).map((t) => t.kind)).toContain("mutual_answer_due");
		await Effect.runPromise(sweepTimers(env));
		expect(await rescindOf(entryId)).toMatchObject({ phase: "final", answered_at: expect.any(Number) });
		expect((await loadTimers(db, sale.saleId, Date.now())).map((t) => t.kind)).not.toContain(
			"mutual_answer_due",
		);
	});
});

describe("admin resolution", () => {
	it("only an admin resolves a contested rescind, and can re-attribute it [SM-4.3.1-contest]", async () => {
		const { sale, buyer, entryId, rescindId } = await rescinded("buyer_nonpayment");
		const base = { saleId: sale.saleId, rescindId };
		// Nothing to resolve before a contest.
		const admin = await addAdmin();
		expect(rejection(await engine.resolveRescind({ ...base, adminId: admin, fault: "seller" }))).toBe(
			"invalid_phase",
		);
		value(await engine.contestRescind({ ...base, buyerId: buyer, text: "I paid within the deadline" }));
		expect(rejection(await engine.resolveRescind({ ...base, adminId: sale.sellerId, fault: "buyer" }))).toBe(
			"not_allowed",
		);
		expect(
			value(
				await engine.resolveRescind({ ...base, adminId: admin, fault: "seller", note: "  Paid on time " }),
			),
		).toMatchObject({ phase: "final", resolvedFault: "seller" });
		expect(await rescindOf(entryId)).toMatchObject({
			phase: "final",
			resolved_fault: "seller",
			resolved_by: admin,
			resolved_at: expect.any(Number),
			resolution_note: "Paid on time",
		});
		const audit = (await auditOf(sale.saleId)).find((a) => a.action === "rescind_resolved");
		expect(audit).toMatchObject({ actor_id: admin, data: { input: { rescindId, fault: "seller" } } });
	});

	it("a suspected-fraud rescind is held until the admin resolves it [SM-4.3.1-fraud-review]", async () => {
		const { sale, buyer, entryId, rescindId, row } = await rescinded("suspected_fraud");
		expect(row).toMatchObject({ phase: "admin_review", fault: "review" });
		// The buyer can't contest a held rescind; the admin decides.
		expect(
			rejection(
				await engine.contestRescind({
					saleId: sale.saleId,
					rescindId,
					buyerId: buyer,
					text: "Not fraud at all",
				}),
			),
		).toBe("invalid_phase");
		value(
			await engine.resolveRescind({
				saleId: sale.saleId,
				rescindId,
				adminId: await addAdmin(),
				fault: "buyer",
			}),
		);
		expect(await rescindOf(entryId)).toMatchObject({ phase: "final", resolved_fault: "buyer" });
	});

	it("the third overturned buyer-fault rescind flags the seller [SM-4.3.1-abuse-guard]", async () => {
		const sellerId = await addUser(uid("seller"));
		const admin = await addAdmin();
		const flags = () =>
			db
				.prepare("SELECT reason, count FROM account_flags WHERE user_id = ?1 AND resolved_at IS NULL")
				.bind(sellerId)
				.all();
		const overturn = async (fault: "buyer" | "seller" | "neutral") => {
			const sale = await makeSale({ sellerId, closesAt: Date.now() + 10 * DAY });
			const { buyer, rescindId } = await rescinded("buyer_nonpayment", sale);
			value(
				await engine.contestRescind({
					saleId: sale.saleId,
					rescindId,
					buyerId: buyer,
					text: "I did pay for it",
				}),
			);
			value(await engine.resolveRescind({ saleId: sale.saleId, rescindId, adminId: admin, fault }));
		};
		await overturn("seller");
		await overturn("buyer"); // upheld: doesn't count
		await overturn("neutral");
		expect((await flags()).results).toEqual([]);
		await overturn("seller");
		expect((await flags()).results).toEqual([{ reason: "overturned_rescinds", count: 3 }]);
		// While the flag is open, more overturns don't add another.
		await overturn("seller");
		expect((await flags()).results).toHaveLength(1);
	});
});

describe("bans", () => {
	it("a banned account's claims are rejected like a blocked buyer's [ADMIN-ban]", async () => {
		const sale = await makeSale();
		const buyer = await addUser();
		await db.prepare("UPDATE users SET banned_at = ?1 WHERE id = ?2").bind(Date.now(), buyer).run();
		expect(rejection(await claim(sale, buyer))).toBe("buyer_blocked");
	});
});
