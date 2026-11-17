import { type Entry, type Invoice } from "@claimsale/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyedLocks } from "../src/sale/locks.ts";
import { loadSale, loadSaleAndItems, Work, WriteConflict } from "../src/sale/store.ts";
import {
	addUser,
	auditOf,
	claim,
	db,
	engine,
	entriesOf,
	entryOf,
	invoicesOf,
	itemRow,
	makeSale,
	offer,
	outcome,
	rejection,
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

describe("the claim race", () => {
	it("N concurrent claims on one unit: exactly one wins, the rest are ranked backups [SM-9-serialized-writes]", async () => {
		const sale = await makeSale({ items: [{ quantity: 1 }] });
		const buyers = await Promise.all(Array.from({ length: 25 }, () => addUser(uid("buyer"))));
		const results = await Promise.all(buyers.map((buyer) => claim(sale, buyer)));

		const statuses = results.map((r) => entryOf(r).status);
		expect(statuses.filter((s) => s === "won")).toHaveLength(1);
		expect(statuses.filter((s) => s === "open")).toHaveLength(24);

		const rows = await entriesOf(sale.itemIds[0]!);
		expect(rows).toHaveLength(25);
		expect(rows.filter((r) => r["status"] === "won")).toHaveLength(1);
		const item = await itemRow(sale.itemIds[0]!);
		expect(item).toMatchObject({ units_won: 1, state: "sold_out", version: 25 });
		// One invoice line for the one winner, and one audit row per claim.
		const invoices = await invoicesOf(sale.saleId);
		expect(invoices).toHaveLength(1);
		expect(invoices[0]!.lines).toHaveLength(1);
		expect((await auditOf(sale.saleId)).filter((a) => a.action === "entry_placed")).toHaveLength(25);
	});

	it("claims on different items run in parallel and each item gets its own winner [SM-9-serialized-writes]", async () => {
		const sale = await makeSale({ items: [{}, {}, {}] });
		const buyers = await Promise.all(Array.from({ length: 9 }, () => addUser(uid("buyer"))));
		await Promise.all(buyers.map((buyer, i) => claim(sale, buyer, sale.itemIds[i % 3])));
		for (const itemId of sale.itemIds) {
			const rows = await entriesOf(itemId);
			expect(rows.filter((r) => r["status"] === "won")).toHaveLength(1);
			expect(rows.filter((r) => r["status"] === "open")).toHaveLength(2);
		}
		// Three winners, three buyers, three draft invoices.
		expect(await invoicesOf(sale.saleId)).toHaveLength(3);
	});

	it("a write whose item version changed underneath is refused as a whole [SM-9-serialized-writes]", async () => {
		const sale = await makeSale();
		const buyer = await addUser();
		const now = Date.now();
		const loaded = await loadSaleAndItems(db, sale.saleId, sale.itemIds, now);
		const work = new Work(db, loaded.sale!, now);
		work.addItems(loaded.items);
		const item = work.item(sale.itemIds[0]!)!;
		const entry: Entry = {
			id: uid("entry"),
			buyerId: buyer,
			kind: "claim",
			amountCents: item.priceCents,
			status: "won",
			createdAt: now,
			rankOverride: null,
			counterCents: null,
			counterExpiresAt: null,
			wonAt: now,
			endedAt: null,
			endedReason: null,
			endedBy: null,
		};
		work.setItem({ ...item, entries: [entry] });
		work.audit({ action: "entry_placed", actorId: buyer, itemId: item.id, events: [] });
		// Someone else writes the item between our read and our write.
		await db.prepare("UPDATE items SET version = version + 1 WHERE id = ?1").bind(item.id).run();
		await expect(work.commit()).rejects.toBeInstanceOf(WriteConflict);
		expect(await entriesOf(item.id)).toEqual([]);
		expect(await auditOf(sale.saleId)).toEqual([]);
	});

	it("serializes holders of the same key and runs different keys side by side [SM-9-serialized-writes]", async () => {
		const locks = new KeyedLocks();
		const order: string[] = [];
		const gate = Promise.withResolvers<void>();
		const first = locks.with(["item:a"], async () => {
			order.push("a1 start");
			await gate.promise;
			order.push("a1 end");
		});
		const second = locks.with(["item:a"], async () => void order.push("a2"));
		const other = locks.with(["item:b"], async () => void order.push("b"));
		await other;
		expect(order).toEqual(["a1 start", "b"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["a1 start", "b", "a1 end", "a2"]);
		expect(locks.busy).toBe(0);
	});
});

describe("placing entries through the engine", () => {
	it("an instant win goes on the buyer's draft invoice [SM-4.1-instant-win]", async () => {
		const sale = await makeSale({ items: [{ priceCents: 1250, title: "Charizard" }] });
		const buyer = await addUser();
		const result = value(await claim(sale, buyer));
		expect(result.entry).toMatchObject({ status: "won", amountCents: 1250, buyerId: buyer });
		expect(result.item).toMatchObject({ state: "sold_out", freeUnits: 0, version: 1 });
		const [invoice] = await invoicesOf(sale.saleId);
		expect(invoice).toMatchObject({
			status: "draft",
			buyer_id: buyer,
			subtotal_cents: 1250,
			total_cents: 1250,
		});
		expect(invoice!.lines).toEqual([
			expect.objectContaining({ entry_id: result.entry!.id, description: "Charizard", amount_cents: 1250 }),
		]);
		expect(invoice!["invoice_number"]).toBe(1);
	});

	it("a rejected command writes nothing, not even an audit row [SM-9-audit]", async () => {
		const sale = await makeSale({
			status: "scheduled",
			liveAt: Date.now() + DAY_MS,
			closesAt: Date.now() + 2 * DAY_MS,
		});
		const buyer = await addUser();
		expect(rejection(await claim(sale, buyer))).toBe("sale_not_live");
		expect(await entriesOf(sale.itemIds[0]!)).toEqual([]);
		expect(await auditOf(sale.saleId)).toEqual([]);
		expect(await itemRow(sale.itemIds[0]!)).toMatchObject({ version: 0 });
	});

	it("rejects an unverified free buyer and lets a Pro buyer through [SM-4.1-buyer-requirements]", async () => {
		const sale = await makeSale({ items: [{}, {}] });
		const unverified = await addUser(uid("b"), { emailVerified: false });
		const pro = await addUser(uid("b"), { emailVerified: false, buyerPro: true });
		expect(rejection(await claim(sale, unverified))).toBe("email_not_verified");
		const blocked = await addUser(uid("b"), { buyerPro: true });
		await db
			.prepare("INSERT INTO blocks (seller_id, blocked_user_id, created_at) VALUES (?1, ?2, 1)")
			.bind(sale.sellerId, blocked)
			.run();
		expect(rejection(await claim(sale, blocked))).toBe("buyer_blocked");
		expect(value(await claim(sale, pro, sale.itemIds[1])).entry?.status).toBe("won");
	});

	it("rejects invalid input as an RPC failure, not a rule outcome", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await engine.placeEntry({ saleId: "s", itemId: "i", buyerId: "b", kind: "bid" } as never);
		expect(result).toMatchObject({ ok: false, error: { name: "SchemaError" } });
		error.mockRestore();
	});

	it("answers not_found for an unknown sale or item", async () => {
		const buyer = await addUser();
		expect(
			outcome(await engine.placeEntry({ saleId: uid("nosale"), itemId: "x", buyerId: buyer, kind: "claim" })),
		).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		const sale = await makeSale();
		expect(rejection(await claim(sale, buyer, uid("noitem")))).toBe("not_found");
	});

	it("a sold-out item takes backup offers, ranked behind the winner [SM-4.1-backup-claim]", async () => {
		const sale = await makeSale();
		const [a, b, c] = await Promise.all([addUser(), addUser(), addUser()]);
		await claim(sale, a);
		expect(entryOf(await claim(sale, b)).status).toBe("open");
		expect(entryOf(await offer(sale, c, 5000)).status).toBe("open");
	});
});

const DAY_MS = 24 * 3_600_000;

describe("the audit log", () => {
	/**
	 * Folds the audit rows' after-states into a fresh state and compares it with D1:
	 * if any write skipped its audit row, or recorded it incompletely, they differ.
	 */
	it("replaying the audit log reproduces the entries, items and invoices [SM-9-audit]", async () => {
		const sale = await makeSale({
			items: [{ quantity: 2, offers: "on" }, { priceCents: 999 }],
			terms: { autoSendAtClose: false },
		});
		const [a, b, c, d] = await Promise.all([addUser(), addUser(), addUser(), addUser()]);
		const [itemA, itemB] = sale.itemIds as [string, string];
		await offer(sale, a, 3000, itemA);
		const claimB = entryOf(await claim(sale, b, itemA)); // deciding: an offer is pending
		const offerA = entryOf(
			await engine.placeEntry({
				saleId: sale.saleId,
				itemId: itemA,
				buyerId: c,
				kind: "offer",
				amountCents: 3500,
			}),
		);
		value(
			await engine.awardEntry({
				saleId: sale.saleId,
				itemId: itemA,
				entryId: claimB.id,
				sellerId: sale.sellerId,
			}),
		);
		value(
			await engine.counterOffer({
				saleId: sale.saleId,
				itemId: itemA,
				entryId: offerA.id,
				sellerId: sale.sellerId,
				amountCents: 3800,
			}),
		);
		value(
			await engine.respondToCounter({
				saleId: sale.saleId,
				itemId: itemA,
				entryId: offerA.id,
				buyerId: c,
				accept: true,
			}),
		);
		const winD = entryOf(await claim(sale, d, itemB));
		await claim(sale, a, itemB);
		value(
			await engine.sellerRescind({
				saleId: sale.saleId,
				itemId: itemB,
				entryId: winD.id,
				sellerId: sale.sellerId,
				reasonCode: "seller_listing_error",
				explanation: "Wrong set listed, sorry about that",
				passToNext: true,
				confirmed: false,
			}),
		);

		const audit = await auditOf(sale.saleId);
		expect(audit.length).toBeGreaterThanOrEqual(8);
		const entries = new Map<string, Entry>();
		const items = new Map<
			string,
			{ decisionDeadline: unknown; offersLapseAt: unknown; withdrawn: unknown }
		>();
		const invoices = new Map<string, Invoice>();
		for (const row of audit) {
			const data = row.data as {
				items: Array<{
					id: string;
					decisionDeadline: unknown;
					offersLapseAt: unknown;
					withdrawn: unknown;
					entries: Entry[];
				}>;
				invoices: Invoice[];
			};
			for (const item of data.items) {
				items.set(item.id, {
					decisionDeadline: item.decisionDeadline,
					offersLapseAt: item.offersLapseAt,
					withdrawn: item.withdrawn,
				});
				for (const entry of item.entries) entries.set(entry.id, entry);
			}
			for (const invoice of data.invoices) invoices.set(invoice.id, invoice);
		}

		for (const itemId of sale.itemIds) {
			const row = await itemRow(itemId);
			expect(items.get(itemId)).toEqual({
				decisionDeadline: row["decision_deadline"],
				offersLapseAt: row["offers_lapse_at"],
				withdrawn: row["withdrawn_at"] !== null,
			});
			for (const e of await entriesOf(itemId)) {
				expect(entries.get(e["id"] as string)).toMatchObject({
					status: e["status"],
					amountCents: e["amount_cents"],
					buyerId: e["user_id"],
					counterCents: e["counter_cents"],
					wonAt: e["won_at"],
					endedReason: e["ended_reason"],
					endedBy: e["ended_by"],
				});
			}
		}
		const stored = await invoicesOf(sale.saleId);
		expect(stored.length).toBe(invoices.size);
		for (const inv of stored) {
			const replayed = invoices.get(inv["id"] as string)!;
			expect(replayed.status).toBe(inv["status"]);
			expect(new Set(replayed.lines.map((l) => l.entryId))).toEqual(
				new Set(inv.lines.map((l) => l["entry_id"])),
			);
		}
	});

	it("every committed command writes exactly one audit row in its batch, with the actor [SM-9-audit]", async () => {
		const sale = await makeSale();
		const buyer = await addUser();
		const won = entryOf(await claim(sale, buyer));
		value(
			await engine.sellerRescind({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: won.id,
				sellerId: sale.sellerId,
				reasonCode: "mutual_agreement",
				explanation: "We agreed in messages to cancel",
				passToNext: false,
				confirmed: false,
			}),
		);
		const audit = await auditOf(sale.saleId);
		expect(audit.map((a) => [a.action, a.actor_id, a.item_id])).toEqual([
			["entry_placed", buyer, sale.itemIds[0]],
			["rescinded", sale.sellerId, sale.itemIds[0]],
		]);
		const loaded = await loadSale(db, sale.saleId, Date.now());
		expect(loaded?.sale.status).toBe("live");
	});
});
