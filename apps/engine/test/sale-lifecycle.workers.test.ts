import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepTimers } from "../src/sale/sweep.ts";
import {
	addUser,
	auditOf,
	claim,
	DAY,
	db,
	engine,
	entriesOf,
	entryOf,
	HOUR,
	itemRow,
	makeSale,
	offer,
	rejection,
	saleRow,
	setClock,
	stubFor,
	uid,
	value,
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

describe("publishing and closing", () => {
	it("a future go-live schedules the sale, arms the alarm, and the alarm makes it live [SM-2-publish-scheduled] [SM-2-go-live-alarm]", async () => {
		const sale = await makeSale({ status: "draft" });
		const liveAt = Date.now() + HOUR;
		const result = value(
			await engine.publishSale({
				saleId: sale.saleId,
				sellerId: sale.sellerId,
				liveAt,
				closesAt: liveAt + DAY,
			}),
		);
		expect(result).toEqual({ status: "scheduled", liveAt, closesAt: liveAt + DAY });
		expect(await saleRow(sale.saleId)).toMatchObject({
			status: "scheduled",
			published_at: expect.any(Number),
		});
		expect(await alarmOf(sale.saleId)).toBe(liveAt);
		// Claims wait for the go-live.
		expect(rejection(await claim(sale, await addUser()))).toBe("sale_not_live");

		await setClock(sale.saleId, liveAt);
		expect(await runDurableObjectAlarm(stubFor(sale.saleId))).toBe(true);
		expect(await saleRow(sale.saleId)).toMatchObject({ status: "live" });
		expect(await alarmOf(sale.saleId)).toBe(liveAt + DAY);
		expect((await auditOf(sale.saleId)).map((a) => [a.action, a.actor_id])).toEqual([
			["sale_published", sale.sellerId],
			["sale_live", "system"],
		]);
	});

	it("no go-live time makes it live now [SM-2-publish-now]", async () => {
		const sale = await makeSale({ status: "draft" });
		const closesAt = Date.now() + DAY;
		const result = value(
			await engine.publishSale({ saleId: sale.saleId, sellerId: sale.sellerId, liveAt: null, closesAt }),
		);
		expect(result).toMatchObject({ status: "live", closesAt });
		expect(entryOf(await claim(sale, await addUser())).status).toBe("won");
	});

	it("refuses a go-live more than 7 days ahead [SM-2-preview-window]", async () => {
		const sale = await makeSale({ status: "draft" });
		const liveAt = Date.now() + 7 * DAY + HOUR;
		expect(
			rejection(
				await engine.publishSale({
					saleId: sale.saleId,
					sellerId: sale.sellerId,
					liveAt,
					closesAt: liveAt + DAY,
				}),
			),
		).toBe("preview_too_early");
		expect(await saleRow(sale.saleId)).toMatchObject({ status: "draft" });
	});

	it("a free seller can't have a third sale scheduled or live; Pro can [SM-2-free-sale-cap]", async () => {
		const seller = await addUser(uid("seller"));
		const sales = [await makeSale({ sellerId: seller }), await makeSale({ sellerId: seller })];
		const third = await makeSale({ status: "draft", sellerId: seller });
		const publish = () =>
			engine.publishSale({
				saleId: third.saleId,
				sellerId: seller,
				liveAt: null,
				closesAt: Date.now() + DAY,
			});
		expect(sales).toHaveLength(2);
		expect(rejection(await publish())).toBe("sale_cap_reached");
		await db
			.prepare(
				"INSERT INTO subscriptions (user_id, plan_id, status, created_at, updated_at) VALUES (?1, 'seller_pro', 'granted', 1, 1)",
			)
			.bind(seller)
			.run();
		expect(value(await publish()).status).toBe("live");
	});

	it("re-checks the free cap inside the write, so two sales can't slip past it together [SM-2-free-sale-cap]", async () => {
		const seller = await addUser(uid("seller"));
		await makeSale({ sellerId: seller });
		const [a, b] = [
			await makeSale({ status: "draft", sellerId: seller }),
			await makeSale({ status: "draft", sellerId: seller }),
		];
		const results = await Promise.all(
			[a, b].map((s) =>
				engine.publishSale({ saleId: s.saleId, sellerId: seller, liveAt: null, closesAt: Date.now() + DAY }),
			),
		);
		const live = results.filter((r) => r.ok && r.value.ok).length;
		expect(live).toBe(1);
	});

	it("re-checks the item cap on publish [SM-2-free-item-cap]", async () => {
		const sale = await makeSale({ status: "draft", items: Array.from({ length: 11 }, () => ({})) });
		expect(
			rejection(
				await engine.publishSale({
					saleId: sale.saleId,
					sellerId: sale.sellerId,
					liveAt: null,
					closesAt: Date.now() + DAY,
				}),
			),
		).toBe("item_cap_reached");
	});

	it("unpublishes a scheduled sale back to a draft; someone else's sale is not found", async () => {
		const sale = await makeSale({ status: "draft" });
		const other = await addUser();
		const liveAt = Date.now() + HOUR;
		expect(
			rejection(
				await engine.publishSale({ saleId: sale.saleId, sellerId: other, liveAt, closesAt: liveAt + DAY }),
			),
		).toBe("not_found");
		value(
			await engine.publishSale({
				saleId: sale.saleId,
				sellerId: sale.sellerId,
				liveAt,
				closesAt: liveAt + DAY,
			}),
		);
		expect(value(await engine.unpublishSale({ saleId: sale.saleId, sellerId: sale.sellerId }))).toEqual({
			status: "draft",
			liveAt: null,
			closesAt: null,
		});
		expect(rejection(await engine.unpublishSale({ saleId: sale.saleId, sellerId: sale.sellerId }))).toBe(
			"invalid_status",
		);
	});

	it("closing rejects new entries, starts the post-close windows and marks empty items unsold [SM-2-close] [SM-4.5-close-unsold]", async () => {
		const sale = await makeSale({ items: [{}, {}, {}] });
		const [a, b] = await Promise.all([addUser(), addUser()]);
		const [claimed, offered, empty] = sale.itemIds as [string, string, string];
		await offer(sale, a, 3000, claimed);
		await claim(sale, b, claimed); // deciding
		await offer(sale, b, 2500, offered);
		const before = await itemRow(claimed);

		const closed = value(await engine.closeSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
		expect(closed.status).toBe("closed");
		expect(rejection(await claim(sale, await addUser(), empty))).toBe("sale_not_live");
		// The running decision window keeps its deadline; the offers-only item gets a lapse window.
		expect(await itemRow(claimed)).toMatchObject({
			decision_deadline: before["decision_deadline"],
			state: "deciding",
		});
		expect(await itemRow(offered)).toMatchObject({ offers_lapse_at: expect.any(Number), state: "available" });
		expect(await itemRow(empty)).toMatchObject({ state: "unsold" });
	});

	it("a non-seller can't close the sale, and buyers can't use seller actions [SM-8-permissions]", async () => {
		const sale = await makeSale();
		const [a, b] = await Promise.all([addUser(), addUser()]);
		await offer(sale, a, 1000);
		const entry = (await entriesOf(sale.itemIds[0]!))[0]!;
		expect(rejection(await engine.closeSale({ saleId: sale.saleId, sellerId: b }))).toBe("not_found");
		const input = {
			saleId: sale.saleId,
			itemId: sale.itemIds[0]!,
			entryId: entry["id"] as string,
			sellerId: b,
		};
		expect(rejection(await engine.awardEntry(input))).toBe("not_allowed");
		expect(rejection(await engine.declineOffer(input))).toBe("not_allowed");
		expect(rejection(await engine.counterOffer({ ...input, amountCents: 900 }))).toBe("not_allowed");
		expect(rejection(await engine.withdrawItem(input))).toBe("not_allowed");
		// Nor can another buyer withdraw someone else's offer.
		expect(rejection(await engine.withdrawEntry({ ...input, buyerId: b }))).toBe("not_allowed");
		// The seller can't claim in their own sale.
		expect(rejection(await claim(sale, sale.sellerId))).toBe("not_allowed");
	});
});

describe("timers and the single alarm", () => {
	it("arms the alarm at the decision deadline and the expiry awards the earliest claim [SM-7-single-alarm] [SM-4.2-window-expiry]", async () => {
		const sale = await makeSale();
		const [a, b, c] = await Promise.all([addUser(), addUser(), addUser()]);
		await offer(sale, a, 9000);
		const first = entryOf(await claim(sale, b));
		await claim(sale, c);
		const deadline = (await itemRow(sale.itemIds[0]!))["decision_deadline"] as number;
		expect(deadline).toBeGreaterThan(Date.now());
		expect(await alarmOf(sale.saleId)).toBe(deadline);

		await setClock(sale.saleId, deadline + 1);
		expect(await runDurableObjectAlarm(stubFor(sale.saleId))).toBe(true);
		const rows = await entriesOf(sale.itemIds[0]!);
		expect(rows.find((r) => r["id"] === first.id)).toMatchObject({ status: "won" });
		// The offer is never auto-awarded; it stays open as a backup.
		expect(rows.find((r) => r["user_id"] === a)).toMatchObject({ status: "open" });
		expect(await itemRow(sale.itemIds[0]!)).toMatchObject({ decision_deadline: null, state: "sold_out" });
		// Re-armed at the next pending timer: the sale's close.
		expect(await alarmOf(sale.saleId)).toBe((await saleRow(sale.saleId))["closes_at"]);
	});

	it("a Pro seller's configured window is used [SM-4.2-window-length]", async () => {
		const sale = await makeSale({
			sellerPro: true,
			terms: { decisionWindowHours: 2, reviewEveryClaim: true },
		});
		await setClock(sale.saleId, 1_800_000_000_000);
		await claim(sale, await addUser());
		expect(await itemRow(sale.itemIds[0]!)).toMatchObject({
			decision_deadline: 1_800_000_000_000 + 2 * HOUR,
			state: "deciding",
		});
	});

	it("an unanswered counter expires through the alarm [SM-4.4-counter-expiry]", async () => {
		const sale = await makeSale({ closesAt: Date.now() + 10 * DAY });
		const buyer = await addUser();
		const entry = entryOf(await offer(sale, buyer, 3000));
		const t0 = Date.now();
		await setClock(sale.saleId, t0);
		value(
			await engine.counterOffer({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: entry.id,
				sellerId: sale.sellerId,
				amountCents: 3500,
			}),
		);
		expect(await alarmOf(sale.saleId)).toBe(t0 + 24 * HOUR);
		await setClock(sale.saleId, t0 + 24 * HOUR);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect((await entriesOf(sale.itemIds[0]!))[0]).toMatchObject({
			status: "declined",
			ended_reason: "counter_expired",
			ended_by: "system",
		});
	});

	it("the close alarm closes the sale and the lapse alarm ends unaccepted offers [SM-4.5-close-offers-lapse]", async () => {
		const closesAt = Date.now() + HOUR;
		const sale = await makeSale({ closesAt });
		const buyer = await addUser();
		await offer(sale, buyer, 2000);
		expect(await alarmOf(sale.saleId)).toBe(closesAt);
		await setClock(sale.saleId, closesAt);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect(await saleRow(sale.saleId)).toMatchObject({ status: "closed" });
		const lapseAt = (await itemRow(sale.itemIds[0]!))["offers_lapse_at"] as number;
		expect(lapseAt).toBe(closesAt + 24 * HOUR);
		expect(await alarmOf(sale.saleId)).toBe(lapseAt);
		await setClock(sale.saleId, lapseAt);
		await runDurableObjectAlarm(stubFor(sale.saleId));
		expect((await entriesOf(sale.itemIds[0]!))[0]).toMatchObject({
			status: "lost",
			ended_reason: "offer_lapsed",
		});
		expect(await itemRow(sale.itemIds[0]!)).toMatchObject({ state: "unsold", offers_lapse_at: null });
	});

	it("the cron sweep runs a due timer whose alarm was lost [SM-7-single-alarm]", async () => {
		const sale = await makeSale({ terms: { reviewEveryClaim: true } });
		const buyer = await addUser();
		await claim(sale, buyer);
		// Lose the alarm and make the deadline due.
		await runInDurableObject(stubFor(sale.saleId), (_i, state) => state.storage.deleteAlarm());
		await db
			.prepare("UPDATE items SET decision_deadline = ?1 WHERE id = ?2")
			.bind(Date.now() - 1000, sale.itemIds[0])
			.run();
		const report = await Effect.runPromise(sweepTimers(env));
		expect(report.sales).toBeGreaterThanOrEqual(1);
		expect((await entriesOf(sale.itemIds[0]!))[0]).toMatchObject({ status: "won" });
		expect(await alarmOf(sale.saleId)).toBe((await saleRow(sale.saleId))["closes_at"]);
	});

	it("a sweep with nothing pending clears the alarm", async () => {
		const sale = await makeSale({ status: "closed", closesAt: Date.now() - HOUR });
		await runInDurableObject(stubFor(sale.saleId), (_i, state) => state.storage.setAlarm(Date.now() + HOUR));
		const report = await stubFor(sale.saleId).sweep(sale.saleId);
		expect(report).toEqual({ ok: true, value: { processed: 0, nextAlarm: null } });
		expect(await alarmOf(sale.saleId)).toBeNull();
	});
});

describe("offers, counters and withdrawals", () => {
	it("the seller counters once; the buyer accepts and wins at the counter amount [SM-4.4-counter]", async () => {
		const sale = await makeSale();
		const buyer = await addUser();
		const entry = entryOf(await offer(sale, buyer, 3000));
		const base = { saleId: sale.saleId, itemId: sale.itemIds[0]!, entryId: entry.id };
		value(await engine.counterOffer({ ...base, sellerId: sale.sellerId, amountCents: 3500 }));
		const accepted = value(await engine.respondToCounter({ ...base, buyerId: buyer, accept: true }));
		expect(accepted.entry).toMatchObject({ status: "won", amountCents: 3500 });
	});

	it("a buyer withdraws a pending offer; a binding claim can't be withdrawn [SM-4.4-withdraw-offer]", async () => {
		const sale = await makeSale({ terms: { reviewEveryClaim: true }, items: [{}, {}] });
		const buyer = await addUser();
		const o = entryOf(await offer(sale, buyer, 3000));
		const c = entryOf(await claim(sale, buyer, sale.itemIds[1]));
		expect(
			value(
				await engine.withdrawEntry({
					saleId: sale.saleId,
					itemId: sale.itemIds[0]!,
					entryId: o.id,
					buyerId: buyer,
				}),
			).entry,
		).toMatchObject({
			status: "withdrawn",
		});
		expect(
			rejection(
				await engine.withdrawEntry({
					saleId: sale.saleId,
					itemId: sale.itemIds[1]!,
					entryId: c.id,
					buyerId: buyer,
				}),
			),
		).toBe("claim_is_binding");
	});

	it("a backup leaves the queue [SM-4.4-leave-backup]", async () => {
		const sale = await makeSale();
		const [a, b] = await Promise.all([addUser(), addUser()]);
		await claim(sale, a);
		const backup = entryOf(await claim(sale, b));
		expect(
			value(
				await engine.withdrawEntry({
					saleId: sale.saleId,
					itemId: sale.itemIds[0]!,
					entryId: backup.id,
					buyerId: b,
				}),
			).entry,
		).toMatchObject({
			status: "withdrawn",
			endedReason: "left_backup_queue",
		});
	});

	it("the seller reorders backups and promotion follows that order [SM-4.2-ranking]", async () => {
		const sale = await makeSale();
		const [a, b, c] = await Promise.all([addUser(), addUser(), addUser()]);
		const winner = entryOf(await claim(sale, a));
		const first = entryOf(await claim(sale, b));
		const second = entryOf(await claim(sale, c));
		const base = { saleId: sale.saleId, itemId: sale.itemIds[0]!, sellerId: sale.sellerId };
		value(await engine.reorderBackups({ ...base, orderedEntryIds: [second.id, first.id] }));
		const rescinded = value(
			await engine.sellerRescind({
				...base,
				entryId: winner.id,
				reasonCode: "buyer_unresponsive",
				explanation: "No reply to three messages over two days",
				passToNext: true,
				confirmed: false,
			}),
		);
		expect(rescinded.events).toContainEqual(
			expect.objectContaining({ type: "entry_won", entryId: second.id, via: "promotion" }),
		);
	});

	it("a Pro seller's hidden minimum declines a low offer through the engine [SM-4.1-min-offer]", async () => {
		const sale = await makeSale({ sellerPro: true, items: [{ offers: "on_min", minOfferCents: 3000 }] });
		const entry = entryOf(await offer(sale, await addUser(), 2000));
		expect(entry).toMatchObject({ status: "declined", endedReason: "below_minimum" });
	});

	it("the seller withdraws an item: pending entries end, winners stay", async () => {
		const sale = await makeSale({ items: [{ quantity: 2 }] });
		const [a, b] = await Promise.all([addUser(), addUser()]);
		await claim(sale, a);
		await offer(sale, b, 1000);
		value(
			await engine.withdrawItem({ saleId: sale.saleId, itemId: sale.itemIds[0]!, sellerId: sale.sellerId }),
		);
		const rows = await entriesOf(sale.itemIds[0]!);
		expect(rows.map((r) => r["status"])).toEqual(["won", "ended"]);
		expect(await itemRow(sale.itemIds[0]!)).toMatchObject({
			state: "withdrawn",
			withdrawn_at: expect.any(Number),
		});
	});
});

describe("removing winners", () => {
	it("rescind and pass: the reason is recorded and the best backup at asking wins [SM-4.3-seller-rescind] [SM-4.3-promote-auto]", async () => {
		const sale = await makeSale();
		const [a, b] = await Promise.all([addUser(), addUser()]);
		const winner = entryOf(await claim(sale, a));
		const backup = entryOf(await claim(sale, b));
		const base = {
			saleId: sale.saleId,
			itemId: sale.itemIds[0]!,
			entryId: winner.id,
			sellerId: sale.sellerId,
			passToNext: true,
			confirmed: false,
		};
		expect(
			rejection(
				await engine.sellerRescind({ ...base, reasonCode: "buyer_unresponsive", explanation: "too short" }),
			),
		).toBe("explanation_too_short");
		value(
			await engine.sellerRescind({
				...base,
				reasonCode: "buyer_unresponsive",
				explanation: "Buyer stopped replying for two days",
			}),
		);
		const rows = await entriesOf(sale.itemIds[0]!);
		expect(rows.find((r) => r["id"] === winner.id)).toMatchObject({
			status: "rescinded",
			ended_by: sale.sellerId,
		});
		expect(rows.find((r) => r["id"] === backup.id)).toMatchObject({ status: "won" });
		const rescind = await db.prepare("SELECT * FROM rescinds WHERE entry_id = ?1").bind(winner.id).first();
		expect(rescind).toMatchObject({
			reason_code: "buyer_unresponsive",
			fault: "buyer",
			buyer_id: a,
			refund_owed: 0,
		});
		// The rescinded line left a's invoice (now cancelled) and b got their own.
		const invoices = await db
			.prepare("SELECT buyer_id, status FROM invoices WHERE sale_id = ?1 ORDER BY created_at")
			.bind(sale.saleId)
			.all();
		expect(invoices.results).toEqual([
			{ buyer_id: a, status: "cancelled" },
			{ buyer_id: b, status: "draft" },
		]);
	});

	it("a backup below asking restarts the decision window [SM-4.3-promote-below-asking]", async () => {
		const sale = await makeSale();
		const [a, b] = await Promise.all([addUser(), addUser()]);
		const winner = entryOf(await claim(sale, a));
		await offer(sale, b, 1000);
		value(
			await engine.sellerRescind({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: winner.id,
				sellerId: sale.sellerId,
				reasonCode: "seller_item_unavailable",
				explanation: "Card got damaged in storage, sorry",
				passToNext: true,
				confirmed: false,
			}),
		);
		expect(await itemRow(sale.itemIds[0]!)).toMatchObject({
			state: "deciding",
			decision_deadline: expect.any(Number),
		});
	});

	it("a plain rescind withdraws the item [SM-4.3-rescind-withdraw]", async () => {
		const sale = await makeSale();
		const [a, b] = await Promise.all([addUser(), addUser()]);
		const winner = entryOf(await claim(sale, a));
		await claim(sale, b);
		value(
			await engine.sellerRescind({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: winner.id,
				sellerId: sale.sellerId,
				reasonCode: "seller_listing_error",
				explanation: "Listed the wrong printing of the card",
				passToNext: false,
				confirmed: false,
			}),
		);
		expect(await itemRow(sale.itemIds[0]!)).toMatchObject({ state: "withdrawn" });
		expect((await entriesOf(sale.itemIds[0]!)).map((r) => r["status"])).toEqual(["rescinded", "ended"]);
	});

	it("a Pro buyer rescinds before the invoice is sent; a free buyer can't [SM-4.3-pro-rescind]", async () => {
		const sale = await makeSale({ items: [{}, {}] });
		const pro = await addUser(uid("pro"), { buyerPro: true });
		const free = await addUser();
		const proWin = entryOf(await claim(sale, pro));
		const freeWin = entryOf(await claim(sale, free, sale.itemIds[1]));
		expect(
			rejection(
				await engine.buyerRescind({
					saleId: sale.saleId,
					itemId: sale.itemIds[1]!,
					entryId: freeWin.id,
					buyerId: free,
				}),
			),
		).toBe("pro_only");
		const result = value(
			await engine.buyerRescind({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: proWin.id,
				buyerId: pro,
			}),
		);
		expect(result.entry).toMatchObject({ status: "released", endedReason: "buyer_rescind" });
		expect(result.item.state).toBe("available");
	});

	it("caps Pro buyer rescinds at 5 per month [SM-4.3-pro-rescind]", async () => {
		const sale = await makeSale({ items: Array.from({ length: 6 }, () => ({})) });
		const pro = await addUser(uid("pro"), { buyerPro: true });
		const outcomes = [];
		for (const itemId of sale.itemIds) {
			const won = entryOf(await claim(sale, pro, itemId));
			outcomes.push(
				await engine.buyerRescind({ saleId: sale.saleId, itemId, entryId: won.id, buyerId: pro }),
			);
		}
		expect(outcomes.slice(0, 5).every((r) => r.ok && r.value.ok)).toBe(true);
		expect(rejection(outcomes[5]!)).toBe("rescind_limit_reached");
	});

	it("take-back: one pending request, the claim stays won; approval releases and promotes [SM-5-takeback-request] [SM-5-takeback-decide]", async () => {
		const sale = await makeSale();
		const [a, b] = await Promise.all([addUser(), addUser()]);
		const winner = entryOf(await claim(sale, a));
		const backup = entryOf(await claim(sale, b));
		const base = { saleId: sale.saleId, itemId: sale.itemIds[0]!, entryId: winner.id, buyerId: a };
		const { requestId } = value(await engine.requestTakeback({ ...base, reason: "Bought it locally" }));
		expect(rejection(await engine.requestTakeback(base))).toBe("already_pending");
		expect((await entriesOf(sale.itemIds[0]!))[0]).toMatchObject({ status: "won" });
		// Only the seller decides.
		expect(
			rejection(await engine.decideTakeback({ saleId: sale.saleId, requestId, sellerId: b, approve: true })),
		).toBe("not_allowed");
		value(
			await engine.decideTakeback({ saleId: sale.saleId, requestId, sellerId: sale.sellerId, approve: true }),
		);
		const rows = await entriesOf(sale.itemIds[0]!);
		expect(rows.find((r) => r["id"] === winner.id)).toMatchObject({
			status: "released",
			ended_reason: "takeback",
		});
		expect(rows.find((r) => r["id"] === backup.id)).toMatchObject({ status: "won" });
		expect(
			await db.prepare("SELECT status FROM takeback_requests WHERE id = ?1").bind(requestId).first(),
		).toEqual({ status: "approved" });
	});

	it("after a denial the buyer can't file again; a cancelled request can be refiled [SM-5-takeback-decide]", async () => {
		const sale = await makeSale({ items: [{}, {}] });
		const a = await addUser();
		const one = entryOf(await claim(sale, a));
		const two = entryOf(await claim(sale, a, sale.itemIds[1]));
		const first = value(
			await engine.requestTakeback({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: one.id,
				buyerId: a,
			}),
		);
		value(
			await engine.decideTakeback({
				saleId: sale.saleId,
				requestId: first.requestId,
				sellerId: sale.sellerId,
				approve: false,
			}),
		);
		expect(
			rejection(
				await engine.requestTakeback({
					saleId: sale.saleId,
					itemId: sale.itemIds[0]!,
					entryId: one.id,
					buyerId: a,
				}),
			),
		).toBe("denied_before");
		const second = value(
			await engine.requestTakeback({
				saleId: sale.saleId,
				itemId: sale.itemIds[1]!,
				entryId: two.id,
				buyerId: a,
			}),
		);
		value(await engine.cancelTakeback({ saleId: sale.saleId, requestId: second.requestId, buyerId: a }));
		value(
			await engine.requestTakeback({
				saleId: sale.saleId,
				itemId: sale.itemIds[1]!,
				entryId: two.id,
				buyerId: a,
			}),
		);
	});

	it("a pending take-back is cancelled when the seller rescinds the win anyway", async () => {
		const sale = await makeSale();
		const a = await addUser();
		const winner = entryOf(await claim(sale, a));
		const { requestId } = value(
			await engine.requestTakeback({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: winner.id,
				buyerId: a,
			}),
		);
		value(
			await engine.sellerRescind({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: winner.id,
				sellerId: sale.sellerId,
				reasonCode: "mutual_agreement",
				explanation: "We agreed to cancel it in messages",
				passToNext: true,
				confirmed: false,
			}),
		);
		expect(
			await db.prepare("SELECT status FROM takeback_requests WHERE id = ?1").bind(requestId).first(),
		).toEqual({ status: "cancelled" });
	});
});

describe("rate limiting", () => {
	it("caps claims and offers per buyer and writes nothing over the limit [SM-9-entry-rate-limit]", async () => {
		const sale = await makeSale({ items: Array.from({ length: 30 }, () => ({})) });
		const buyer = await addUser();
		const results = [];
		for (const itemId of sale.itemIds) results.push(await claim(sale, buyer, itemId));
		const limited = results.filter((r) => r.ok && !r.value.ok && r.value.error.code === "rate_limited");
		expect(limited.length).toBeGreaterThan(0);
		const placed = await db
			.prepare("SELECT count(*) AS n FROM entries e JOIN items i ON i.id = e.item_id WHERE i.sale_id = ?1")
			.bind(sale.saleId)
			.first<{ n: number }>();
		expect(placed!.n).toBe(results.length - limited.length);
		// Another buyer isn't affected.
		expect(entryOf(await claim(sale, await addUser(), sale.itemIds.at(-1))).status).toMatch(/won|open/);
	});
});
