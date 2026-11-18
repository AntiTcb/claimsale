import type { LiveItem, MyEntry } from "@claimsale/core";
import { describe, expect, it } from "vitest";
import {
	announcements,
	currentEntry,
	matchesFilter,
	mergeItems,
	mergeSale,
	NO_FILTER,
	parseDollars,
	positionLabel,
	saleAnnouncement,
} from "./state.ts";

const item = (overrides: Partial<LiveItem> = {}): LiveItem => ({
	id: "i1",
	version: 1,
	state: "available",
	quantity: 1,
	freeUnits: 1,
	unitsWon: 0,
	claimCount: 0,
	offerCount: 0,
	decisionDeadline: null,
	offers: [],
	mine: [],
	...overrides,
});

const entry = (overrides: Partial<MyEntry> = {}): MyEntry => ({
	id: "e1",
	kind: "claim",
	status: "open",
	amountCents: 4000,
	counterCents: null,
	counterExpiresAt: null,
	endedReason: null,
	position: { kind: "backup", rank: 2 },
	...overrides,
});

describe("merging what the socket sends", () => {
	it("keeps each item's highest version, whatever order frames arrive in [LIVE-broadcast]", () => {
		const start = { i1: item({ version: 3, claimCount: 1 }) };
		const stale = mergeItems(start, [item({ version: 2 }), item({ version: 3 })]);
		expect(stale.items).toBe(start);
		expect(stale.changed).toEqual([]);

		const fresh = mergeItems(start, [item({ version: 4, claimCount: 2 })]);
		expect(fresh.items["i1"]).toMatchObject({ version: 4, claimCount: 2 });
		expect(fresh.changed).toHaveLength(1);
		expect(fresh.unknown).toEqual([]);

		const added = mergeItems(start, [item({ id: "i2", version: 0 })]);
		expect(added.unknown).toEqual(["i2"]);
		expect(added.items["i2"]).toBeDefined();
	});

	it("keeps the newer sale state [LIVE-broadcast]", () => {
		const scheduled = { status: "scheduled", liveAt: 5, closesAt: 9, at: 10 } as const;
		const live = { status: "live", liveAt: 5, closesAt: 9, at: 20 } as const;
		expect(mergeSale(null, scheduled)).toBe(scheduled);
		expect(mergeSale(live, scheduled)).toBe(live);
		expect(mergeSale(scheduled, live)).toBe(live);
		expect(saleAnnouncement(scheduled, live)).toBe("The sale is live. Claims are open.");
		expect(saleAnnouncement(live, { ...live, status: "closed", at: 30 })).toBe("The sale has closed.");
		expect(saleAnnouncement(live, { ...live, at: 31 })).toBeUndefined();
		expect(saleAnnouncement(live, { ...live, status: "draft", at: 32 })).toBeUndefined();
	});
});

describe("the buyer's position", () => {
	it("labels winners, backups, waiting entries and counters [LIVE-position]", () => {
		expect(positionLabel(entry({ status: "won", position: { kind: "won", rank: 1 } }))).toBe("You're #1");
		expect(positionLabel(entry())).toBe("Backup #2");
		expect(positionLabel(entry({ position: { kind: "waiting", rank: 3 } }))).toBe(
			"#3 in line · seller deciding",
		);
		expect(
			positionLabel(
				entry({ kind: "offer", status: "countered", counterCents: 3550, position: { kind: "countered" } }),
			),
		).toBe("Countered at $35.50");
		expect(
			positionLabel(
				entry({ status: "declined", endedReason: "seller_declined", position: { kind: "ended" } }),
			),
		).toBe("Offer declined");
		expect(positionLabel(entry({ status: "ended", endedReason: null, position: { kind: "ended" } }))).toBe(
			"Ended",
		);
	});

	it("speaks for the latest entry that's still going", () => {
		const declined = entry({ id: "a", status: "declined", position: { kind: "ended" } });
		const open = entry({ id: "b" });
		expect(currentEntry(item({ mine: [open, declined] }))).toBe(open);
		expect(currentEntry(item({ mine: [declined] }))).toBe(declined);
		expect(currentEntry(undefined)).toBeUndefined();
	});

	it("announces the buyer's own changes only, once each [LIVE-position]", () => {
		const won = item({ version: 2, mine: [entry({ status: "won", position: { kind: "won", rank: 1 } })] });
		expect(announcements(item(), won, "Charizard")).toEqual(["You're #1 — Charizard is yours."]);
		expect(announcements(won, { ...won, version: 3, claimCount: 4 }, "Charizard")).toEqual([]);
		const backup = item({ mine: [entry()] });
		expect(announcements(undefined, backup, "Pikachu")).toEqual(["You're backup #2 for Pikachu."]);
		expect(
			announcements(backup, item({ mine: [entry({ position: { kind: "backup", rank: 1 } })] }), "Pikachu"),
		).toEqual(["You're backup #1 for Pikachu."]);
		expect(
			announcements(undefined, item({ mine: [entry({ position: { kind: "waiting", rank: 1 } })] }), "Mew"),
		).toEqual(["The seller is deciding on Mew. You're #1 in line."]);
		expect(
			announcements(
				undefined,
				item({
					mine: [
						entry({
							kind: "offer",
							status: "countered",
							counterCents: 3000,
							position: { kind: "countered" },
						}),
					],
				}),
				"Mew",
			),
		).toEqual(["The seller countered your offer on Mew at $30.00."]);
		expect(
			announcements(
				backup,
				item({
					mine: [entry({ status: "rescinded", endedReason: "seller_rescind", position: { kind: "ended" } })],
				}),
				"Mew",
			),
		).toEqual(["Mew: rescinded by the seller."]);
		// Leaving the queue was the buyer's own doing.
		expect(
			announcements(
				backup,
				item({
					mine: [
						entry({ status: "withdrawn", endedReason: "left_backup_queue", position: { kind: "ended" } }),
					],
				}),
				"Mew",
			),
		).toEqual([]);
	});
});

describe("filters", () => {
	const base = { id: "i1", priceCents: 4000, gameId: "pokemon", state: "available" as const };

	it("filter by status, game, price and the buyer's own items", () => {
		expect(matchesFilter(base, undefined, NO_FILTER)).toBe(true);
		expect(matchesFilter(base, undefined, { ...NO_FILTER, status: "available" })).toBe(true);
		expect(matchesFilter(base, item({ state: "sold_out" }), { ...NO_FILTER, status: "available" })).toBe(
			false,
		);
		expect(matchesFilter(base, item({ state: "deciding" }), { ...NO_FILTER, status: "available" })).toBe(
			true,
		);
		expect(matchesFilter(base, item({ state: "sold_out" }), { ...NO_FILTER, status: "sold" })).toBe(true);
		expect(matchesFilter(base, item(), { ...NO_FILTER, status: "backups" })).toBe(false);
		expect(matchesFilter(base, item({ offerCount: 1 }), { ...NO_FILTER, status: "backups" })).toBe(true);
		expect(matchesFilter(base, item(), { ...NO_FILTER, status: "mine" })).toBe(false);
		expect(matchesFilter(base, item({ mine: [entry()] }), { ...NO_FILTER, status: "mine" })).toBe(true);
		expect(
			matchesFilter(base, item({ mine: [entry({ position: { kind: "ended" } })] }), {
				...NO_FILTER,
				status: "mine",
			}),
		).toBe(false);
		expect(matchesFilter(base, undefined, { ...NO_FILTER, gameId: "mtg" })).toBe(false);
		expect(matchesFilter(base, undefined, { ...NO_FILTER, minCents: 4001 })).toBe(false);
		expect(matchesFilter(base, undefined, { ...NO_FILTER, maxCents: 3999 })).toBe(false);
		expect(matchesFilter(base, undefined, { ...NO_FILTER, minCents: 4000, maxCents: 4000 })).toBe(true);
	});

	it("reads dollar amounts as integer cents", () => {
		expect(parseDollars("35")).toBe(3500);
		expect(parseDollars(" $35.5 ")).toBe(3550);
		expect(parseDollars("1,234.05")).toBe(123_405);
		for (const bad of ["", "0", "abc", "1.234", "-5", "9999999"]) expect(parseDollars(bad)).toBeUndefined();
	});
});
