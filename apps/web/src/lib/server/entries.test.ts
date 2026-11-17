import { createDb, eq, type Db } from "@claimsale/db";
import { sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { parsePlaceEntry, placeEntry, type EntriesBinding } from "./entries.ts";
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
