import { createDb, type Db } from "@claimsale/db";
import {
	entries,
	invoiceLines,
	invoices,
	items,
	rescinds,
	sales,
	takebackRequests,
} from "@claimsale/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { loadControlRoom, moveInQueue, runControlAction, type ControlRoomEngine } from "./control-room.ts";

const T = 1_800_000_000_000;
let db: Db;

async function seed() {
	db = createDb(testD1());
	for (const id of ["seller", "ash", "misty", "brock", "gary"]) await addUser(db, id);
	await db.insert(sales).values({
		id: "s1",
		sellerId: "seller",
		slug: "s1",
		title: "Sale",
		status: "live",
		createdAt: T,
		updatedAt: T,
	});
	await db.insert(items).values([
		{
			id: "i1",
			saleId: "s1",
			sortOrder: 0,
			gameId: "pokemon",
			title: "Charizard",
			priceCents: 4000,
			quantity: 1,
			state: "sold_out",
			createdAt: T,
			updatedAt: T,
		},
		{
			id: "i2",
			saleId: "s1",
			sortOrder: 1,
			gameId: "pokemon",
			title: "Pikachu",
			priceCents: 1000,
			quantity: 2,
			state: "deciding",
			decisionDeadline: T + 3_600_000,
			createdAt: T,
			updatedAt: T,
		},
	]);
	const entry = (id: string, itemId: string, userId: string, over: Partial<typeof entries.$inferInsert>) => ({
		id,
		itemId,
		userId,
		kind: "claim" as const,
		amountCents: 4000,
		status: "open" as const,
		createdAt: T,
		...over,
	});
	await db.insert(entries).values([
		entry("e-win", "i1", "ash", { status: "won", wonAt: T + 1 }),
		// Ranked: misty's higher offer first, then brock's earlier claim, then gary's later claim.
		entry("e-brock", "i1", "brock", { createdAt: T + 2 }),
		entry("e-gary", "i1", "gary", { createdAt: T + 3 }),
		entry("e-misty", "i1", "misty", { kind: "offer", amountCents: 4500, createdAt: T + 4 }),
		entry("e-old", "i1", "gary", { status: "declined", kind: "offer", amountCents: 100, createdAt: T }),
		entry("e-counter", "i2", "ash", {
			kind: "offer",
			amountCents: 700,
			status: "countered",
			counterCents: 900,
			counterExpiresAt: T + 86_400_000,
		}),
	]);
	await db.insert(invoices).values({
		id: "inv1",
		saleId: "s1",
		buyerId: "ash",
		sellerId: "seller",
		status: "buyer_paid",
		createdAt: T,
		updatedAt: T,
	});
	await db.insert(invoiceLines).values({
		id: "l1",
		invoiceId: "inv1",
		entryId: "e-win",
		description: "Charizard",
		amountCents: 4000,
		createdAt: T,
	});
	await db.insert(takebackRequests).values({
		id: "tb1",
		entryId: "e-win",
		buyerId: "ash",
		reason: "Changed my mind",
		status: "pending",
		createdAt: T + 5,
	});
	// Ash's record: one final non-pay elsewhere, one still contested (counts for no one).
	await db
		.insert(entries)
		.values([
			entry("e-past1", "i2", "ash", { status: "rescinded" }),
			entry("e-past2", "i2", "ash", { status: "rescinded" }),
		]);
	await db.insert(rescinds).values([
		{
			id: "r1",
			entryId: "e-past1",
			sellerId: "seller",
			buyerId: "ash",
			reasonCode: "buyer_nonpayment",
			explanation: "Did not pay in time at all",
			fault: "buyer",
			phase: "final",
			createdAt: T,
		},
		{
			id: "r2",
			entryId: "e-past2",
			sellerId: "seller",
			buyerId: "ash",
			reasonCode: "buyer_unresponsive",
			explanation: "Stopped replying for days",
			fault: "buyer",
			phase: "contested",
			contestedAt: T + 1,
			createdAt: T,
		},
	]);
}

beforeEach(seed);

describe("loading the control room", () => {
	it("[SM-4.2-ranking] shows winners, the ranked queue, counters, take-backs and rescinds", async () => {
		const room = await loadControlRoom(db, "s1");
		const [charizard, pikachu] = room.items;
		expect(charizard!.winners.map((e) => [e.id, e.invoiceStatus])).toEqual([["e-win", "buyer_paid"]]);
		expect(charizard!.queue.map((e) => e.id)).toEqual(["e-misty", "e-brock", "e-gary"]);
		expect(pikachu).toMatchObject({ state: "deciding", decisionDeadline: T + 3_600_000 });
		expect(pikachu!.countered.map((e) => [e.id, e.counterCents])).toEqual([["e-counter", 900]]);
		expect(room.takebacks).toEqual([
			{
				id: "tb1",
				entryId: "e-win",
				itemId: "i1",
				itemTitle: "Charizard",
				buyerId: "ash",
				reason: "Changed my mind",
				createdAt: T + 5,
			},
		]);
		expect(room.rescinds.map((r) => [r.id, r.phase, r.itemTitle])).toEqual([
			["r1", "final", "Pikachu"],
			["r2", "contested", "Pikachu"],
		]);
	});

	it("[REP-buyer-record] shows each claimant's record; a contested rescind counts for no one", async () => {
		const room = await loadControlRoom(db, "s1");
		expect(room.buyers["ash"]).toMatchObject({
			handle: "ash",
			record: { completedPurchases: 0, nonPay: 1, takebacks: 0, violations: 0 },
		});
		expect(Object.keys(room.buyers).toSorted()).toEqual(["ash", "brock", "gary", "misty"]);
		// No email or phone in the view.
		expect(JSON.stringify(room)).not.toContain("@example.test");
	});

	it("is empty for a sale without items", async () => {
		await db
			.insert(sales)
			.values({ id: "s2", sellerId: "seller", slug: "s2", title: "Empty", createdAt: T, updatedAt: T });
		expect(await loadControlRoom(db, "s2")).toEqual({ items: [], buyers: {}, takebacks: [], rescinds: [] });
	});
});

const ok = { ok: true, value: { ok: true, value: {} } };
function fakeEngine(answer: unknown = ok) {
	const call = vi.fn<(input: unknown) => Promise<unknown>>(async () => answer);
	const engine = {
		awardEntry: call,
		declineOffer: call,
		counterOffer: call,
		reorderBackups: call,
		sellerRescind: call,
		decideTakeback: call,
		withdrawItem: call,
	} as unknown as ControlRoomEngine;
	return { engine, call };
}

const form = (fields: Record<string, string>) => {
	const data = new FormData();
	for (const [k, v] of Object.entries(fields)) data.set(k, v);
	return data;
};
const ctx = { saleId: "s1", sellerId: "seller" };

describe("control room actions", () => {
	it("[SM-8-permissions] passes the authenticated seller to every engine command", async () => {
		const { engine, call } = fakeEngine();
		const entry = { itemId: "i1", entryId: "e-brock" };
		expect(await runControlAction(db, engine, ctx, "award", form(entry))).toEqual({
			ok: true,
			value: "Awarded.",
		});
		await runControlAction(db, engine, ctx, "decline", form(entry));
		await runControlAction(db, engine, ctx, "withdrawItem", form({ itemId: "i1" }));
		await runControlAction(db, engine, ctx, "approveTakeback", form({ requestId: "tb1" }));
		await runControlAction(db, engine, ctx, "denyTakeback", form({ requestId: "tb1" }));
		expect(call.mock.calls.map(([input]) => input)).toEqual([
			{ saleId: "s1", itemId: "i1", entryId: "e-brock", sellerId: "seller" },
			{ saleId: "s1", itemId: "i1", entryId: "e-brock", sellerId: "seller" },
			{ saleId: "s1", itemId: "i1", sellerId: "seller" },
			{ saleId: "s1", requestId: "tb1", sellerId: "seller", approve: true },
			{ saleId: "s1", requestId: "tb1", sellerId: "seller", approve: false },
		]);
	});

	it("[SM-4.4-counter] counters in integer cents and refuses a bad amount before the engine", async () => {
		const { engine, call } = fakeEngine();
		const base = { itemId: "i1", entryId: "e-misty" };
		expect(
			await runControlAction(db, engine, ctx, "counter", form({ ...base, amount: "nope" })),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_amount" },
		});
		expect(call).not.toHaveBeenCalled();
		await runControlAction(db, engine, ctx, "counter", form({ ...base, amount: "$42.50" }));
		expect(call).toHaveBeenCalledWith({
			saleId: "s1",
			itemId: "i1",
			entryId: "e-misty",
			sellerId: "seller",
			amountCents: 4250,
		});
	});

	it("[SM-4.3-seller-rescind] sends the reason code, explanation, pass-to-next and the paid confirmation", async () => {
		const { engine, call } = fakeEngine();
		const base = { itemId: "i1", entryId: "e-win", explanation: "Card was damaged in storage" };
		expect(
			await runControlAction(db, engine, ctx, "rescind", form({ ...base, reasonCode: "made_up" })),
		).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		const result = await runControlAction(
			db,
			engine,
			ctx,
			"rescind",
			form({ ...base, reasonCode: "seller_item_unavailable", passToNext: "on", confirmed: "on" }),
		);
		expect(result).toEqual({ ok: true, value: "Rescinded and passed to the next in line." });
		expect(call).toHaveBeenCalledWith({
			saleId: "s1",
			itemId: "i1",
			entryId: "e-win",
			sellerId: "seller",
			reasonCode: "seller_item_unavailable",
			explanation: "Card was damaged in storage",
			passToNext: true,
			confirmed: true,
		});
		await runControlAction(db, engine, ctx, "rescind", form({ ...base, reasonCode: "seller_listing_error" }));
		expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ passToNext: false, confirmed: false }));
	});

	it("[SM-4.2-ranking] moves a backup up or down in the ranked order", async () => {
		expect(await moveInQueue(db, "i1", "e-gary", -1)).toEqual(["e-misty", "e-gary", "e-brock"]);
		expect(await moveInQueue(db, "i1", "e-misty", -1)).toEqual(["e-misty", "e-brock", "e-gary"]);
		expect(await moveInQueue(db, "i1", "e-misty", 1)).toEqual(["e-brock", "e-misty", "e-gary"]);
		expect(await moveInQueue(db, "i1", "e-win", 1)).toBeNull();
		const { engine, call } = fakeEngine();
		await runControlAction(
			db,
			engine,
			ctx,
			"moveBackup",
			form({ itemId: "i1", entryId: "e-gary", direction: "up" }),
		);
		expect(call).toHaveBeenCalledWith({
			saleId: "s1",
			itemId: "i1",
			sellerId: "seller",
			orderedEntryIds: ["e-misty", "e-gary", "e-brock"],
		});
		expect(
			await runControlAction(
				db,
				engine,
				ctx,
				"moveBackup",
				form({ itemId: "i1", entryId: "e-win", direction: "down" }),
			),
		).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	});

	it("passes the engine's rejection through, and turns a defect or a throw into a retryable error", async () => {
		const no = {
			ok: true,
			value: { ok: false, error: { code: "no_free_unit", message: "No unit is free" } },
		};
		const entry = form({ itemId: "i1", entryId: "e-brock" });
		expect(await runControlAction(db, fakeEngine(no).engine, ctx, "award", entry)).toEqual({
			ok: false,
			error: { code: "no_free_unit", message: "No unit is free" },
		});
		const defect = { ok: false, error: { name: "Error", message: "boom" } };
		expect(await runControlAction(db, fakeEngine(defect).engine, ctx, "award", entry)).toMatchObject({
			ok: false,
			error: { code: "engine_unavailable" },
		});
		const throwing = {
			awardEntry: async () => Promise.reject(new Error("down")),
		} as unknown as ControlRoomEngine;
		expect(await runControlAction(db, throwing, ctx, "award", entry)).toMatchObject({
			ok: false,
			error: { code: "engine_unavailable" },
		});
	});

	it("asks for the missing field instead of calling the engine", async () => {
		const { engine, call } = fakeEngine();
		for (const action of [
			"award",
			"decline",
			"counter",
			"moveBackup",
			"rescind",
			"approveTakeback",
			"withdrawItem",
		] as const) {
			expect(await runControlAction(db, engine, ctx, action, form({}))).toMatchObject({
				ok: false,
				error: { code: "invalid_input" },
			});
		}
		expect(call).not.toHaveBeenCalled();
	});
});
