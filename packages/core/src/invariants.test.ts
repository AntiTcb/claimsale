/**
 * Domain invariants (TESTING §2), checked with fast-check after every step of
 * random command sequences. Invariant 8 (audit replay) needs the engine's audit
 * log and is covered with the write path (SM-9, milestone 5).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HOUR, MINUTE, type Actor, type Tier } from "./common.ts";
import { total, type Invoice } from "./invoice.ts";
import {
	award,
	buyerRescind,
	closeItem,
	compareRank,
	counter,
	declineOffer,
	expireCounter,
	expireDecisionWindow,
	lapseOffersAfterClose,
	loseBackups,
	place,
	rankedOpenEntries,
	releaseForTakeback,
	reorder,
	respondToCounter,
	sellerRescind,
	TERMINAL_STATUSES,
	unitsHeld,
	withdraw,
	type Item,
	type ItemContext,
	type ItemResult,
} from "./item.ts";
import {
	createRescind,
	recordEffects,
	resolve,
	RESCIND_REASONS,
	type Fault,
	type RescindReasonCode,
} from "./rescind.ts";
import { admin, makeBuyer, makeContext, makeInvoice, makeItem, seller, SELLER, T0 } from "./testing.ts";

const BUYERS = ["b1", "b2", "b3", "b4"] as const;
const REASONS = Object.keys(RESCIND_REASONS) as RescindReasonCode[];

type Op =
	| { op: "claim"; buyer: number }
	| { op: "offer"; buyer: number; amount: number }
	| { op: "award"; entry: number; actor: number }
	| { op: "counter"; entry: number; amount: number; actor: number }
	| { op: "respond"; entry: number; accept: boolean }
	| { op: "decline"; entry: number; actor: number }
	| { op: "withdraw"; entry: number; buyer: number }
	| { op: "rescind"; entry: number; pass: boolean; actor: number }
	| { op: "buyerRescind"; entry: number; buyer: number; tier: Tier }
	| { op: "takeback"; entry: number; actor: number }
	| { op: "reorder"; seed: number }
	| { op: "tick"; minutes: number }
	| { op: "expire" }
	| { op: "close" }
	| { op: "paid"; units: number };

const index = fc.nat({ max: 20 });
// 0 = the item's seller (most of the time); 1–3 are actors who may not decide.
const actorIndex = fc.oneof(
	{ weight: 4, arbitrary: fc.constant(0) },
	{ weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }) },
);
const opArb: fc.Arbitrary<Op> = fc.oneof(
	{ weight: 4, arbitrary: fc.record({ op: fc.constant("claim" as const), buyer: fc.nat({ max: 3 }) }) },
	{
		weight: 3,
		arbitrary: fc.record({
			op: fc.constant("offer" as const),
			buyer: fc.nat({ max: 3 }),
			amount: fc.integer({ min: 1, max: 8000 }),
		}),
	},
	{ weight: 3, arbitrary: fc.record({ op: fc.constant("award" as const), entry: index, actor: actorIndex }) },
	{
		weight: 2,
		arbitrary: fc.record({
			op: fc.constant("counter" as const),
			entry: index,
			amount: fc.integer({ min: 1, max: 8000 }),
			actor: actorIndex,
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({ op: fc.constant("respond" as const), entry: index, accept: fc.boolean() }),
	},
	{
		weight: 1,
		arbitrary: fc.record({ op: fc.constant("decline" as const), entry: index, actor: actorIndex }),
	},
	{
		weight: 2,
		arbitrary: fc.record({ op: fc.constant("withdraw" as const), entry: index, buyer: fc.nat({ max: 3 }) }),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			op: fc.constant("rescind" as const),
			entry: index,
			pass: fc.boolean(),
			actor: actorIndex,
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			op: fc.constant("buyerRescind" as const),
			entry: index,
			buyer: fc.nat({ max: 3 }),
			tier: fc.constantFrom<Tier>("free", "pro"),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({ op: fc.constant("takeback" as const), entry: index, actor: actorIndex }),
	},
	{ weight: 1, arbitrary: fc.record({ op: fc.constant("reorder" as const), seed: fc.nat() }) },
	{
		weight: 2,
		arbitrary: fc.record({ op: fc.constant("tick" as const), minutes: fc.integer({ min: 1, max: 48 * 60 }) }),
	},
	{ weight: 2, arbitrary: fc.record({ op: fc.constant("expire" as const) }) },
	{ weight: 1, arbitrary: fc.record({ op: fc.constant("close" as const) }) },
	{ weight: 1, arbitrary: fc.record({ op: fc.constant("paid" as const), units: fc.nat({ max: 3 }) }) },
);

const scenarioArb = fc.record({
	quantity: fc.integer({ min: 1, max: 3 }),
	perBuyerLimit: fc.integer({ min: 1, max: 2 }),
	reviewEveryClaim: fc.boolean(),
	allowBackupOffers: fc.boolean(),
	sellerTier: fc.constantFrom<Tier>("free", "pro"),
	minOfferCents: fc.option(fc.integer({ min: 1, max: 5000 }), { nil: null }),
	ops: fc.array(opArb, { minLength: 10, maxLength: 80, size: "max" }),
});

/** Actor 0 is the item's seller; 1 is another seller; 2 and 3 are buyers. */
function deciderActor(i: number): Actor {
	if (i === 0) return seller();
	if (i === 1) return { kind: "seller", id: "someone_else", tier: "pro" };
	return { kind: "buyer", id: BUYERS[i - 2] ?? "b1", tier: "pro" };
}

function checkInvariants(item: Item): void {
	// 1. Won entries ≤ quantity.
	expect(unitsHeld(item)).toBeLessThanOrEqual(item.quantity);
	// 2. A buyer never has two pending entries on the item.
	const pending = item.entries
		.filter((e) => e.status === "open" || e.status === "countered")
		.map((e) => e.buyerId);
	expect(new Set(pending).size).toBe(pending.length);
	// 3. Ranking is a total order, and stable.
	const ranked = rankedOpenEntries(item);
	for (let i = 0; i + 1 < ranked.length; i += 1) {
		expect(compareRank(ranked[i]!, ranked[i + 1]!)).toBeLessThan(0);
		expect(compareRank(ranked[i + 1]!, ranked[i]!)).toBeGreaterThan(0);
	}
	expect(rankedOpenEntries({ ...item, entries: item.entries.toReversed() }).map((e) => e.id)).toEqual(
		ranked.map((e) => e.id),
	);
	// 4. Every terminal entry records when, why and by whom; every win records when.
	const unrecorded = item.entries.filter(
		(e) =>
			(TERMINAL_STATUSES.has(e.status) &&
				(e.endedAt === null || e.endedReason === null || e.endedBy === null)) ||
			(e.status === "won" && e.wonAt === null),
	);
	expect(unrecorded).toEqual([]);
}

/** Statuses an entry can move to from each status (STATE_MACHINES §4 diagram). */
const ALLOWED: Record<string, ReadonlySet<string>> = {
	open: new Set(["open", "won", "countered", "declined", "withdrawn", "lost", "ended"]),
	countered: new Set(["countered", "won", "open", "declined", "lost", "ended"]),
	won: new Set(["won", "rescinded", "released", "fulfilled"]),
};

describe("domain invariants (property tests)", () => {
	it("[SM-8-permissions] [SM-4.2-ranking] random command sequences keep every item invariant", () => {
		fc.assert(
			fc.property(scenarioArb, (scenario) => {
				const context: ItemContext = makeContext({
					reviewEveryClaim: scenario.reviewEveryClaim,
					allowBackupOffers: scenario.allowBackupOffers,
					sellerTier: scenario.sellerTier,
				});
				let ctx = context;
				let item = makeItem({
					quantity: scenario.quantity,
					perBuyerLimit: scenario.perBuyerLimit,
					minOfferCents: scenario.minOfferCents,
				});
				let now = T0;
				let nextId = 0;
				const entryAt = (i: number) => item.entries[i % Math.max(1, item.entries.length)];

				for (const op of scenario.ops) {
					now += MINUTE;
					let result: ItemResult | undefined;
					let actor: Actor | undefined;
					switch (op.op) {
						case "claim":
						case "offer": {
							nextId += 1;
							const command =
								op.op === "claim"
									? { entryId: `e${nextId}`, kind: "claim" as const }
									: { entryId: `e${nextId}`, kind: "offer" as const, amountCents: op.amount };
							result = place(item, ctx, makeBuyer(BUYERS[op.buyer]!), command, now);
							break;
						}
						case "award":
							actor = deciderActor(op.actor);
							result = award(item, ctx, actor, entryAt(op.entry)?.id ?? "none", now);
							break;
						case "counter":
							actor = deciderActor(op.actor);
							result = counter(item, ctx, actor, entryAt(op.entry)?.id ?? "none", op.amount, now);
							break;
						case "respond": {
							const entry = entryAt(op.entry);
							if (entry)
								result = respondToCounter(
									item,
									{ kind: "buyer", id: entry.buyerId, tier: "free" },
									entry.id,
									op.accept,
									now,
								);
							break;
						}
						case "decline":
							actor = deciderActor(op.actor);
							result = declineOffer(item, ctx, actor, entryAt(op.entry)?.id ?? "none", now);
							break;
						case "withdraw":
							result = withdraw(
								item,
								{ kind: "buyer", id: BUYERS[op.buyer]!, tier: "free" },
								entryAt(op.entry)?.id ?? "none",
								now,
							);
							break;
						case "rescind":
							actor = deciderActor(op.actor);
							result = sellerRescind(
								item,
								ctx,
								actor,
								{
									entryId: entryAt(op.entry)?.id ?? "none",
									reasonCode: "buyer_nonpayment",
									explanation: "Did not pay within the deadline.",
									passToNext: op.pass,
									afterBuyerPaid: false,
									confirmed: false,
								},
								now,
							);
							break;
						case "buyerRescind":
							result = buyerRescind(
								item,
								ctx,
								{ kind: "buyer", id: BUYERS[op.buyer]!, tier: op.tier },
								{ entryId: entryAt(op.entry)?.id ?? "none", invoiceSent: false, rescindsThisMonth: 0 },
								now,
							);
							break;
						case "takeback":
							actor = deciderActor(op.actor);
							result = releaseForTakeback(item, ctx, actor, entryAt(op.entry)?.id ?? "none", now);
							break;
						case "reorder": {
							const open = item.entries.filter((e) => e.status === "open").map((e) => e.id);
							const order = open.toSorted(
								(a, b) =>
									((a.length * 31 + op.seed) % 7) - ((b.length * 31 + op.seed) % 7) || (a < b ? -1 : 1),
							);
							result = reorder(item, ctx, seller(), order);
							break;
						}
						case "tick":
							now += op.minutes * MINUTE;
							break;
						case "expire": {
							for (const entry of item.entries) {
								const expired = expireCounter(item, entry.id, now);
								if (expired.ok) item = expired.value.item;
							}
							const window = expireDecisionWindow(item, now);
							if (window.ok) item = window.value.item;
							const lapse = lapseOffersAfterClose(item, now);
							if (lapse.ok) item = lapse.value.item;
							break;
						}
						case "close":
							if (ctx.saleStatus === "live") {
								ctx = { ...ctx, saleStatus: "closed" };
								item = closeItem(item, ctx, now).item;
							}
							break;
						case "paid":
							item = loseBackups(item, ctx.saleStatus, Math.min(op.units, unitsHeld(item)), now).item;
							break;
					}

					// 7. Deciding actions by anyone but this item's seller are always rejected.
					const unauthorized = actor !== undefined && !(actor.kind === "seller" && actor.id === SELLER);
					expect(unauthorized && result?.ok === true).toBe(false);
					const before = new Map(item.entries.map((e) => [e.id, e.status]));
					if (result?.ok) item = result.value.item;
					// Terminal entries never change; others only follow the diagram.
					const illegal = item.entries
						.map((e) => [before.get(e.id), e.status] as const)
						.filter(([was, now_]) => was !== undefined && was !== now_ && ALLOWED[was]?.has(now_) !== true);
					expect(illegal).toEqual([]);
					checkInvariants(item);
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("[SM-6-rescind-line] an invoice total is the sum of lines, shipping and adjustments, and never negative", () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ amount: fc.nat({ max: 100_000 }), refundOwed: fc.boolean() }), {
					maxLength: 20,
				}),
				fc.nat({ max: 5000 }),
				fc.integer({ min: -200_000, max: 5000 }),
				(lines, shipping, adjustment) => {
					const invoice: Invoice = makeInvoice({
						lines: lines.map((l, i) => ({
							entryId: `e${i}`,
							description: "",
							amountCents: l.amount,
							refundOwed: l.refundOwed,
						})),
						shippingCents: shipping,
						adjustmentCents: adjustment,
					});
					const counted = lines.filter((l) => !l.refundOwed).reduce((sum, l) => sum + l.amount, 0);
					expect(total(invoice)).toBe(Math.max(0, counted + shipping + adjustment));
					expect(total(invoice)).toBeGreaterThanOrEqual(0);
				},
			),
		);
	});

	it("[SM-4.3.1-seller-fault] [SM-4.3.1-contest] fault attribution only changes the record it names", () => {
		const resolution = fc.option(fc.constantFrom<Fault>("buyer", "seller", "neutral"), { nil: undefined });
		fc.assert(
			fc.property(fc.constantFrom(...REASONS), fc.boolean(), resolution, (code, afterPaid, resolveTo) => {
				let rescind = createRescind(code, afterPaid, T0);
				if (resolveTo !== undefined && rescind.phase === "admin_review") {
					const resolved = resolve(rescind, admin, resolveTo);
					if (resolved.ok) rescind = resolved.value;
				}
				const effects = recordEffects(rescind);
				const fault = rescind.phase === "final" ? (rescind.resolvedFault ?? rescind.fault) : "review";
				expect({ buyerMarked: effects.buyer !== null, sellerMarked: effects.seller !== null }).toEqual({
					buyerMarked: fault === "buyer",
					sellerMarked: fault === "seller",
				});
				expect([null, "seller_cancel"]).toContain(effects.seller);
			}),
		);
	});

	it("[SM-4.1-one-open-entry] [SM-4.1-unit-limit] a burst of claims never oversells or double-enters", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }),
				fc.integer({ min: 1, max: 3 }),
				fc.array(fc.nat({ max: 5 }), { maxLength: 40 }),
				(quantity, perBuyerLimit, buyers) => {
					let item = makeItem({ quantity, perBuyerLimit });
					buyers.forEach((b, i) => {
						const result = place(
							item,
							makeContext(),
							makeBuyer(`u${b}`),
							{ entryId: `c${i}`, kind: "claim" },
							T0 + i * HOUR,
						);
						if (result.ok) item = result.value.item;
					});
					checkInvariants(item);
					const wonBy = new Map<string, number>();
					for (const e of item.entries.filter((x) => x.status === "won"))
						wonBy.set(e.buyerId, (wonBy.get(e.buyerId) ?? 0) + 1);
					for (const count of wonBy.values()) expect(count).toBeLessThanOrEqual(perBuyerLimit);
				},
			),
		);
	});
});
