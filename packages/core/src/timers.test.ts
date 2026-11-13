import { describe, expect, it } from "vitest";
import { DAY, HOUR } from "./common.ts";
import { can, type Action } from "./permissions.ts";
import { dueTimers, nextAlarm, pendingTimers } from "./timers.ts";
import {
	admin,
	buyerActor,
	makeEntry,
	makeInvoice,
	makeItem,
	makeSale,
	seller,
	system,
	T0,
} from "./testing.ts";
import { entryCounts, visibleOffers } from "./visibility.ts";

describe("timers", () => {
	const sale = makeSale({ status: "live", liveAt: T0, closesAt: T0 + 5 * DAY });
	const items = [
		makeItem({ id: "i1", decisionDeadline: T0 + 2 * HOUR }),
		makeItem({
			id: "i2",
			offersLapseAt: T0 + 3 * HOUR,
			entries: [
				makeEntry({
					id: "o1",
					buyerId: "b",
					kind: "offer",
					status: "countered",
					counterExpiresAt: T0 + HOUR,
				}),
			],
		}),
	];
	const invoices = [
		makeInvoice({ id: "v1", status: "sent", dueAt: T0 + 4 * HOUR }),
		makeInvoice({ id: "v2", status: "shipped", shippedAt: T0 }),
		makeInvoice({ id: "v3", status: "paid" }),
	];

	it("[SM-7-single-alarm] collects every pending timer and arms one alarm at the earliest", () => {
		const timers = pendingTimers(sale, items, invoices);
		expect(timers.map((t) => t.kind).toSorted()).toEqual(
			[
				"counter_expiry",
				"decision_deadline",
				"invoice_autocomplete",
				"invoice_due",
				"offers_lapse",
				"sale_close",
			].toSorted(),
		);
		expect(nextAlarm(timers)).toBe(T0 + HOUR);
		expect(nextAlarm([])).toBeNull();
	});

	it("[SM-7-single-alarm] processes everything due, earliest first", () => {
		const timers = pendingTimers(sale, items, invoices);
		expect(dueTimers(timers, T0 + 2 * HOUR).map((t) => t.kind)).toEqual([
			"counter_expiry",
			"decision_deadline",
		]);
		expect(dueTimers(timers, T0)).toEqual([]);
	});

	it("[SM-7-single-alarm] a scheduled sale's go-live and close are timers; a draft has none", () => {
		const scheduled = makeSale({ status: "scheduled", liveAt: T0 + DAY, closesAt: T0 + 2 * DAY });
		expect(pendingTimers(scheduled, [], []).map((t) => t.kind)).toEqual(["sale_live", "sale_close"]);
		expect(pendingTimers(makeSale(), [], [])).toEqual([]);
	});
});

describe("permissions", () => {
	const all: Action[] = [
		"place_entry",
		"withdraw_offer",
		"leave_backup_queue",
		"rescind_own_win",
		"request_takeback",
		"award",
		"decline_offer",
		"counter",
		"configure_decision_window",
		"set_hidden_min_offer",
		"set_offer_visibility",
		"choose_24h_payment_deadline",
		"rescind_and_pass",
		"reorder_backups",
	];
	const allowed = (actor: Parameters<typeof can>[0]) => all.filter((action) => can(actor, action));

	it("[SM-8-permissions] free buyers enter, withdraw and request take-backs; Pro buyers can also rescind", () => {
		expect(allowed(buyerActor("b", "free"))).toEqual([
			"place_entry",
			"withdraw_offer",
			"leave_backup_queue",
			"request_takeback",
		]);
		expect(allowed(buyerActor("b", "pro"))).toEqual([
			"place_entry",
			"withdraw_offer",
			"leave_backup_queue",
			"rescind_own_win",
			"request_takeback",
		]);
	});

	it("[SM-8-permissions] sellers decide; only Pro sellers configure the window, hidden minimum and 24h deadline", () => {
		const free = allowed(seller("free"));
		expect(free).toEqual([
			"award",
			"decline_offer",
			"counter",
			"set_offer_visibility",
			"rescind_and_pass",
			"reorder_backups",
		]);
		expect(allowed(seller("pro"))).toEqual([
			...free.slice(0, 3),
			"configure_decision_window",
			"set_hidden_min_offer",
			"set_offer_visibility",
			"choose_24h_payment_deadline",
			"rescind_and_pass",
			"reorder_backups",
		]);
	});

	it("[SM-8-permissions] admins and the system take none of these actions", () => {
		expect(allowed(admin)).toEqual([]);
		expect(allowed(system)).toEqual([]);
	});
});

describe("what buyers see", () => {
	const item = makeItem({
		entries: [
			makeEntry({ id: "c1", buyerId: "zoe", createdAt: T0 }),
			makeEntry({ id: "o1", buyerId: "amy", kind: "offer", amountCents: 3000, createdAt: T0 + 1 }),
			makeEntry({
				id: "o2",
				buyerId: "bob",
				kind: "offer",
				amountCents: 3500,
				status: "countered",
				createdAt: T0 + 2,
			}),
			makeEntry({
				id: "o3",
				buyerId: "cat",
				kind: "offer",
				amountCents: 9000,
				status: "declined",
				createdAt: T0 + 3,
			}),
		],
	});

	it("[SM-3-counts-public] pending claim and offer counts are always visible", () => {
		expect(entryCounts(item)).toEqual({ claims: 1, offers: 2 });
	});

	it("[SM-3-offer-visibility] blind hides amounts from the public; the seller sees them", () => {
		expect(visibleOffers(item, "blind", "public")).toEqual([]);
		expect(visibleOffers(item, "blind", "seller").map((o) => o.amountCents)).toEqual([3500, 3000]);
	});

	it("[SM-3-offer-visibility] visible shows amounts with anonymous labels; only the seller sees names", () => {
		expect(visibleOffers(item, "visible", "public")).toEqual([
			{ label: "Buyer C", amountCents: 3500 },
			{ label: "Buyer B", amountCents: 3000 },
		]);
		expect(visibleOffers(item, "visible", "seller")[0]).toEqual({
			label: "Buyer C",
			amountCents: 3500,
			buyerId: "bob",
		});
	});

	it("[SM-3-offer-visibility] labels continue past Z", () => {
		const many = makeItem({
			entries: Array.from({ length: 28 }, (_, i) =>
				makeEntry({ id: `o${i}`, buyerId: `u${i}`, kind: "offer", amountCents: 100 - i, createdAt: T0 + i }),
			),
		});
		const labels = visibleOffers(many, "visible", "public").map((o) => o.label);
		expect(labels.slice(25)).toEqual(["Buyer Z", "Buyer AA", "Buyer AB"]);
	});
});
