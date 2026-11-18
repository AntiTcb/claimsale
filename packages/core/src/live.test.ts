import { describe, expect, it } from "vitest";
import { liveItem, runningTotal, type LiveViewer } from "./live.ts";
import { makeEntry, makeItem, T0 } from "./testing.ts";

const ann: LiveViewer = { kind: "buyer", id: "ann" };
const bob: LiveViewer = { kind: "buyer", id: "bob" };

/** One copy: Ann won it, Bob and Cat are backups, Dan has an offer and Eve's offer was declined. */
const soldOut = makeItem({
	quantity: 1,
	minOfferCents: 2500,
	entries: [
		makeEntry({ id: "e1", buyerId: "ann", status: "won", wonAt: T0, createdAt: T0 }),
		makeEntry({ id: "e2", buyerId: "bob", createdAt: T0 + 1 }),
		makeEntry({ id: "e3", buyerId: "cat", createdAt: T0 + 2 }),
		makeEntry({ id: "e4", buyerId: "dan", kind: "offer", amountCents: 4500, createdAt: T0 + 3 }),
		makeEntry({
			id: "e5",
			buyerId: "eve",
			kind: "offer",
			amountCents: 1000,
			status: "declined",
			endedReason: "below_minimum",
			createdAt: T0 + 4,
		}),
	],
});

describe("the live grid projection", () => {
	it("[SM-3-counts-public] counts pending claims and offers for every viewer", () => {
		for (const viewer of [ann, { kind: "visitor" } as const, { kind: "seller" } as const]) {
			const view = liveItem(soldOut, 7, "live", "blind", viewer);
			expect(view).toMatchObject({
				id: "item_1",
				version: 7,
				state: "sold_out",
				quantity: 1,
				freeUnits: 0,
				unitsWon: 1,
				claimCount: 2,
				offerCount: 1,
			});
		}
	});

	it("[SM-3-offer-visibility] blind sends no amounts to buyers; visible sends anonymous labels", () => {
		expect(liveItem(soldOut, 1, "live", "blind", bob).offers).toEqual([]);
		expect(liveItem(soldOut, 1, "live", "blind", { kind: "visitor" }).offers).toEqual([]);
		expect(liveItem(soldOut, 1, "live", "blind", { kind: "seller" }).offers).toEqual([
			{ label: "Buyer D", amountCents: 4500 },
		]);
		expect(liveItem(soldOut, 1, "live", "visible", bob).offers).toEqual([
			{ label: "Buyer D", amountCents: 4500 },
		]);
	});

	it("[LIVE-no-leak] never carries another buyer's ID, the hidden minimum or a market price", () => {
		for (const viewer of [ann, bob, { kind: "visitor" } as const, { kind: "seller" } as const]) {
			const text = JSON.stringify(liveItem(soldOut, 1, "live", "visible", viewer));
			for (const other of ["bob", "cat", "dan", "eve"].filter(
				(id) => viewer.kind !== "buyer" || id !== viewer.id,
			)) {
				expect(text).not.toContain(`"${other}"`);
			}
			expect(text).not.toContain("buyerId");
			expect(text).not.toContain("2500");
			expect(text).not.toMatch(/market|minOffer/i);
		}
		// The seller's view of the offers keeps the labels only; names belong to the control room.
		expect(liveItem(soldOut, 1, "live", "visible", { kind: "seller" }).mine).toEqual([]);
		expect(liveItem(soldOut, 1, "live", "visible", { kind: "visitor" }).mine).toEqual([]);
	});

	it("[LIVE-position] the winner is #1 and the claims behind are backups #1 and #2 in rank order", () => {
		expect(liveItem(soldOut, 1, "live", "blind", ann).mine).toEqual([
			{
				id: "e1",
				kind: "claim",
				status: "won",
				amountCents: 4000,
				counterCents: null,
				counterExpiresAt: null,
				endedReason: null,
				position: { kind: "won", rank: 1 },
			},
		]);
		// Dan's $45 offer outranks both $40 claims (amount desc, then time).
		expect(liveItem(soldOut, 1, "live", "blind", { kind: "buyer", id: "dan" }).mine[0]!.position).toEqual({
			kind: "backup",
			rank: 1,
		});
		expect(liveItem(soldOut, 1, "live", "blind", bob).mine[0]!.position).toEqual({ kind: "backup", rank: 2 });
		expect(liveItem(soldOut, 1, "live", "blind", { kind: "buyer", id: "cat" }).mine[0]!.position).toEqual({
			kind: "backup",
			rank: 3,
		});
		expect(liveItem(soldOut, 1, "live", "blind", { kind: "buyer", id: "eve" }).mine[0]).toMatchObject({
			status: "declined",
			endedReason: "below_minimum",
			position: { kind: "ended" },
		});
	});

	it("[LIVE-position] winners of a multi-copy item are numbered by when they won; open entries wait while units are free", () => {
		const item = makeItem({
			quantity: 3,
			decisionDeadline: T0 + 1000,
			entries: [
				makeEntry({ id: "b", buyerId: "bob", status: "won", wonAt: T0 + 5, createdAt: T0 + 1 }),
				makeEntry({ id: "a", buyerId: "ann", status: "fulfilled", wonAt: T0 + 2, createdAt: T0 }),
				makeEntry({ id: "c", buyerId: "cat", createdAt: T0 + 3 }),
				makeEntry({
					id: "d",
					buyerId: "dan",
					kind: "offer",
					amountCents: 3000,
					status: "countered",
					counterCents: 3500,
					counterExpiresAt: T0 + 99,
					createdAt: T0 + 4,
				}),
			],
		});
		expect(liveItem(item, 1, "live", "blind", ann).mine[0]!.position).toEqual({ kind: "won", rank: 1 });
		expect(liveItem(item, 1, "live", "blind", bob).mine[0]!.position).toEqual({ kind: "won", rank: 2 });
		expect(liveItem(item, 1, "live", "blind", { kind: "buyer", id: "cat" })).toMatchObject({
			state: "deciding",
			freeUnits: 1,
			decisionDeadline: T0 + 1000,
			mine: [{ position: { kind: "waiting", rank: 1 } }],
		});
		expect(liveItem(item, 1, "live", "blind", { kind: "buyer", id: "dan" }).mine[0]).toMatchObject({
			counterCents: 3500,
			counterExpiresAt: T0 + 99,
			position: { kind: "countered" },
		});
	});

	it("[LIVE-running-total] sums the buyer's won entries across the sale, in cents", () => {
		const items = [
			liveItem(soldOut, 1, "live", "blind", ann),
			liveItem(
				makeItem({
					id: "item_2",
					quantity: 2,
					entries: [
						makeEntry({ id: "x", buyerId: "ann", amountCents: 1250, status: "won", wonAt: T0 }),
						makeEntry({ id: "y", buyerId: "ann", amountCents: 999, status: "open" }),
					],
				}),
				1,
				"live",
				"blind",
				ann,
			),
		];
		expect(runningTotal(items)).toEqual({ cents: 5250, count: 2 });
		expect(runningTotal([liveItem(soldOut, 1, "live", "blind", bob)])).toEqual({ cents: 0, count: 0 });
		expect(runningTotal([])).toEqual({ cents: 0, count: 0 });
	});

	it("[SM-3-derived-state] the state follows the sale: unsold after close with no pending entries", () => {
		expect(liveItem(makeItem(), 1, "closed", "blind", ann).state).toBe("unsold");
		expect(liveItem(makeItem(), 1, "live", "blind", ann).state).toBe("available");
	});
});
