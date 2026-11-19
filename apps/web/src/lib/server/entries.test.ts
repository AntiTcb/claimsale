import { createDb, eq, type Db } from "@claimsale/db";
import { sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import {
	entryAction,
	parseEntryAction,
	parsePlaceEntry,
	placeEntry,
	SALE_GATE_TTL_MS,
	SaleGateCache,
	type EntriesBinding,
	type EntryActionsBinding,
} from "./entries.ts";
import { createDraft, setPrivateAccess } from "./sales.ts";

const SECRET = "test-secret-at-least-32-characters-long";
const now = Date.UTC(2026, 10, 15, 12);
const buyer = { id: "buyer", email: "buyer@example.test", emailVerified: true };

let db: Db;
beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	await addUser(db, "buyer");
});

function fakeEngine(answer: unknown) {
	const calls: unknown[] = [];
	const engine = {
		placeEntry: async (input: unknown) => {
			calls.push(input);
			return answer;
		},
	} as unknown as EntriesBinding;
	return { engine, calls };
}

async function liveSale(visibility: "unlisted" | "private" = "unlisted") {
	const sale = await createDraft(
		db,
		{ id: "seller", tier: "pro" },
		{ title: "Sale", descriptionMd: "", visibility },
		now,
	);
	if (!sale.ok) throw new Error("setup");
	await db.update(sales).set({ status: "live", liveAt: now }).where(eq(sales.id, sale.value.id));
	return sale.value.id;
}

const won = {
	ok: true,
	value: {
		ok: true,
		value: {
			entry: { id: "e1", kind: "claim", status: "won", amountCents: 500, buyerId: "buyer" },
			item: { id: "i1", state: "sold_out", freeUnits: 0, decisionDeadline: null, version: 1 },
			events: [],
		},
	},
};

describe("claims and offers from the web", () => {
	it("parses a claim or an offer and nothing else", () => {
		expect(parsePlaceEntry({ itemId: "i1", kind: "claim" })).toEqual({ itemId: "i1", kind: "claim" });
		expect(parsePlaceEntry({ itemId: "i1", kind: "offer", amountCents: 350 })).toEqual({
			itemId: "i1",
			kind: "offer",
			amountCents: 350,
		});
		for (const bad of [
			null,
			"claim",
			{ itemId: "i1", kind: "offer" },
			{ itemId: "i1", kind: "offer", amountCents: 3.5 },
			{ kind: "claim" },
		]) {
			expect(parsePlaceEntry(bad)).toBeUndefined();
		}
	});

	it("sends the signed-in buyer's claim to the engine and answers 201", async () => {
		const saleId = await liveSale();
		const { engine, calls } = fakeEngine(won);
		const response = await placeEntry(
			{ db, secret: SECRET, engine },
			{ user: buyer, unlockCookie: undefined },
			saleId,
			{
				itemId: "i1",
				kind: "claim",
			},
		);
		expect(response).toEqual({
			status: 201,
			body: {
				entry: { id: "e1", kind: "claim", status: "won", amountCents: 500 },
				item: { id: "i1", state: "sold_out", version: 1 },
			},
		});
		expect(calls).toEqual([{ saleId, itemId: "i1", buyerId: "buyer", kind: "claim" }]);
	});

	it("needs a signed-in user and a valid body", async () => {
		const saleId = await liveSale();
		const { engine, calls } = fakeEngine(won);
		const deps = { db, secret: SECRET, engine };
		expect(
			(
				await placeEntry(deps, { user: null, unlockCookie: undefined }, saleId, {
					itemId: "i1",
					kind: "claim",
				})
			).status,
		).toBe(401);
		expect(
			(await placeEntry(deps, { user: buyer, unlockCookie: undefined }, saleId, { kind: "bid" })).status,
		).toBe(400);
		expect(calls).toEqual([]);
	});

	it("a private sale the buyer can't open is not found, without asking the engine [SM-2-visibility]", async () => {
		const saleId = await liveSale("private");
		await setPrivateAccess(db, saleId, { passwordHash: "pbkdf2$1$x$y", allowlist: null }, now);
		const { engine, calls } = fakeEngine(won);
		const response = await placeEntry(
			{ db, secret: SECRET, engine },
			{ user: buyer, unlockCookie: undefined },
			saleId,
			{
				itemId: "i1",
				kind: "claim",
			},
		);
		expect(response.status).toBe(404);
		expect(calls).toEqual([]);
	});

	it("maps the engine's rejections and failures to HTTP statuses", async () => {
		const saleId = await liveSale();
		const viewer = { user: buyer, unlockCookie: undefined };
		const cases: Array<[unknown, number]> = [
			[{ ok: true, value: { ok: false, error: { code: "rate_limited", message: "slow down" } } }, 429],
			[{ ok: true, value: { ok: false, error: { code: "email_not_verified", message: "verify" } } }, 403],
			[{ ok: true, value: { ok: false, error: { code: "already_entered", message: "once" } } }, 409],
			[{ ok: false, error: { name: "Error", message: "boom" } }, 503],
		];
		for (const [answer, status] of cases) {
			const { engine } = fakeEngine(answer);
			expect(
				(await placeEntry({ db, secret: SECRET, engine }, viewer, saleId, { itemId: "i1", kind: "claim" }))
					.status,
			).toBe(status);
		}
	});
});

describe("the sale lookup on the claim path", () => {
	const viewer = { user: buyer, unlockCookie: undefined };
	const claim = { itemId: "i1", kind: "claim" };

	it("[SM-9-claim-access-cache] reads a public or unlisted sale from D1 at most once every 5 seconds", async () => {
		const saleId = await liveSale();
		let clock = now;
		const gates = new SaleGateCache(() => clock);
		const { engine, calls } = fakeEngine(won);
		const deps = { db, secret: SECRET, engine, gates };
		expect((await placeEntry(deps, viewer, saleId, claim)).status).toBe(201);
		// Deleted in D1 meanwhile: the cached row still lets the claim reach the engine,
		// which reads the sale itself and has the final say.
		await db.update(sales).set({ status: "deleted" }).where(eq(sales.id, saleId));
		clock += SALE_GATE_TTL_MS - 1;
		expect((await placeEntry(deps, viewer, saleId, claim)).status).toBe(201);
		clock += 1;
		expect((await placeEntry(deps, viewer, saleId, claim)).status).toBe(404);
		expect(calls).toHaveLength(2);
	});

	it("[SM-9-claim-access-cache] reads a private sale every time, so losing access applies at once", async () => {
		const saleId = await liveSale("private");
		await setPrivateAccess(db, saleId, { allowlist: [buyer.email] }, now);
		const gates = new SaleGateCache(() => now);
		const { engine, calls } = fakeEngine(won);
		const deps = { db, secret: SECRET, engine, gates };
		expect((await placeEntry(deps, viewer, saleId, claim)).status).toBe(201);
		await setPrivateAccess(db, saleId, { passwordHash: "pbkdf2$1$x$y", allowlist: null }, now);
		expect((await placeEntry(deps, viewer, saleId, claim)).status).toBe(404);
		expect(
			(
				await entryAction(
					{ db, secret: SECRET, engine: fakeActionEngine(won).engine, gates },
					viewer,
					saleId,
					"e1",
					{
						itemId: "i1",
						action: "withdraw_offer",
					},
				)
			).status,
		).toBe(404);
		expect(calls).toHaveLength(1);
	});
});

function fakeActionEngine(answer: unknown) {
	const calls: Array<[string, unknown]> = [];
	const engine = {
		withdrawEntry: async (input: unknown) => {
			calls.push(["withdrawEntry", input]);
			return answer;
		},
		respondToCounter: async (input: unknown) => {
			calls.push(["respondToCounter", input]);
			return answer;
		},
	} as unknown as EntryActionsBinding;
	return { engine, calls };
}

const withdrawn = {
	ok: true,
	value: {
		ok: true,
		value: {
			entry: { id: "e1", kind: "offer", status: "withdrawn", amountCents: 500, buyerId: "buyer" },
			item: { id: "i1", state: "available", freeUnits: 1, decisionDeadline: null, version: 3 },
			events: [],
		},
	},
};

describe("a buyer's own entry from the web", () => {
	const viewer = { user: buyer, unlockCookie: undefined };

	it("parses an item and a known action, and nothing else", () => {
		expect(parseEntryAction({ itemId: "i1", action: "leave_queue" })).toEqual({
			itemId: "i1",
			action: "leave_queue",
		});
		for (const body of [
			null,
			"x",
			{ itemId: "i1" },
			{ itemId: "", action: "withdraw_offer" },
			{ itemId: "i1", action: "rescind" },
		])
			expect(parseEntryAction(body)).toBeUndefined();
	});

	it("[SM-4.4-withdraw-offer] [SM-4.4-leave-backup] [SM-4.4-counter] sends each action to the right engine command", async () => {
		const saleId = await liveSale();
		const { engine, calls } = fakeActionEngine(withdrawn);
		const deps = { db, secret: SECRET, engine };
		const act = (action: string) => entryAction(deps, viewer, saleId, "e1", { itemId: "i1", action });
		expect(await act("withdraw_offer")).toEqual({
			status: 200,
			body: {
				entry: { id: "e1", kind: "offer", status: "withdrawn", amountCents: 500 },
				item: { id: "i1", state: "available", version: 3 },
			},
		});
		await act("leave_queue");
		await act("accept_counter");
		await act("decline_counter");
		const command = { saleId, itemId: "i1", entryId: "e1", buyerId: "buyer" };
		expect(calls).toEqual([
			["withdrawEntry", command],
			["withdrawEntry", command],
			["respondToCounter", { ...command, accept: true }],
			["respondToCounter", { ...command, accept: false }],
		]);
	});

	it("needs a signed-in buyer, a valid body and a sale they can open, before asking the engine", async () => {
		const saleId = await liveSale("private");
		await setPrivateAccess(db, saleId, { passwordHash: "pbkdf2$1$x$y", allowlist: null }, now);
		const { engine, calls } = fakeActionEngine(withdrawn);
		const deps = { db, secret: SECRET, engine };
		const body = { itemId: "i1", action: "withdraw_offer" };
		expect(
			(await entryAction(deps, { user: null, unlockCookie: undefined }, saleId, "e1", body)).status,
		).toBe(401);
		expect((await entryAction(deps, viewer, saleId, "e1", { itemId: "i1" })).status).toBe(400);
		expect((await entryAction(deps, viewer, saleId, "", body)).status).toBe(400);
		expect((await entryAction(deps, viewer, saleId, "e1", body)).status).toBe(404);
		expect(calls).toEqual([]);
	});

	it("passes the engine's no along with a status", async () => {
		const saleId = await liveSale();
		const cases: Array<[unknown, number, string | undefined]> = [
			[
				{ ok: true, value: { ok: false, error: { code: "claim_is_binding", message: "binding" } } },
				409,
				"claim_is_binding",
			],
			[
				{ ok: true, value: { ok: false, error: { code: "not_allowed", message: "not yours" } } },
				403,
				"not_allowed",
			],
			[{ ok: false, error: { name: "Error", message: "boom" } }, 503, "engine_unavailable"],
		];
		for (const [answer, status, code] of cases) {
			const { engine } = fakeActionEngine(answer);
			const response = await entryAction({ db, secret: SECRET, engine }, viewer, saleId, "e1", {
				itemId: "i1",
				action: "leave_queue",
			});
			expect([response.status, response.body["code"]]).toEqual([status, code]);
		}
	});
});
