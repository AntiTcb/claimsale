import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLocalSchema, withoutCapture } from "../src/sale/local-db.ts";
import { flushOutbox, pendingOutbox } from "../src/sale/outbox.ts";
import {
	addUser,
	claim,
	db,
	engine,
	entryOf,
	invoicesOf,
	makeSale,
	rejection,
	settle,
	stubFor,
	uid,
	value,
} from "./sale-fixtures.ts";

/**
 * The sale's rows in its SaleEngine's own SQLite, and the outbox that copies them to D1
 * (STATE_MACHINES §9, WS-N). The rest of the suite runs against both stores (the `engine`
 * and `engine-d1` projects); this file is about the local store's own mechanics, so only
 * the `engine` project runs it (vitest.config.ts).
 */

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	quiet = [vi.spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

/** The engine's local rows of one table, for one sale's items. */
async function localRows(saleId: string, query: string, ...params: unknown[]) {
	return runInDurableObject(stubFor(saleId), (_i, state) =>
		state.storage.sql.exec(query, ...(params as SqlStorageValue[])).toArray(),
	);
}

describe("the local store", () => {
	it("[SM-9-local-store] [SM-9-outbox] a claim commits in the engine, and D1 gets the same rows", async () => {
		const sale = await makeSale();
		const buyer = await addUser();
		const entry = entryOf(await claim(sale, buyer));
		const [mine] = await localRows(sale.saleId, "SELECT * FROM entries WHERE id = ?1", entry.id);
		expect(mine).toMatchObject({ user_id: buyer, status: "won" });

		await settle(sale.saleId);
		const theirs = await db.prepare("SELECT * FROM entries WHERE id = ?1").bind(entry.id).first();
		expect(theirs).toEqual(mine);
		const [item] = await localRows(sale.saleId, "SELECT state, version, units_won FROM items");
		expect(
			await db
				.prepare("SELECT state, version, units_won FROM items WHERE id = ?1")
				.bind(sale.itemIds[0])
				.first(),
		).toEqual(item);
		// D1 numbers the invoice (per seller, across sales); the audit row lives in D1 only.
		const [invoice] = await invoicesOf(sale.saleId);
		expect(invoice).toMatchObject({ buyer_id: buyer, invoice_number: 1, status: "draft" });
		expect(invoice!.lines).toHaveLength(1);
		expect(await localRows(sale.saleId, "SELECT * FROM audit_log")).toEqual([]);
		expect(await localRows(sale.saleId, "SELECT * FROM _outbox")).toEqual([]);
	});

	it("[SM-9-hydrate] copies the sale's existing rows in from D1 the first time", async () => {
		const sale = await makeSale({ items: [{ quantity: 1 }] });
		const [first, second] = [await addUser(), await addUser()];
		const itemId = sale.itemIds[0]!;
		// Written before this engine ever served the sale (as if by the d1 store).
		await db.batch([
			db
				.prepare(
					"INSERT INTO entries (id, item_id, user_id, kind, amount_cents, status, won_at, created_at) VALUES (?1, ?2, ?3, 'claim', 4000, 'won', ?4, ?4)",
				)
				.bind(uid("entry"), itemId, first, Date.now() - 1000),
			db
				.prepare("UPDATE items SET units_won = 1, state = 'sold_out', version = 1 WHERE id = ?1")
				.bind(itemId),
		]);
		expect(rejection(await claim(sale, first))).toBe("unit_limit_reached");
		expect(entryOf(await claim(sale, second)).status).toBe("open");
	});

	it("[SM-9-local-store] picks up an item the web Worker added after the engine copied the sale in", async () => {
		const sale = await makeSale();
		value(await claim(sale, await addUser()));
		const added = uid("item");
		await db
			.prepare(
				`INSERT INTO items (id, sale_id, sort_order, game_id, title, price_cents, quantity, per_buyer_limit, offers_mode, created_at, updated_at)
				VALUES (?1, ?2, 9, 'pokemon', 'New card', 1500, 1, 1, 'on', 1, 1)`,
			)
			.bind(added, sale.saleId)
			.run();
		expect(entryOf(await claim(sale, await addUser(), added))).toMatchObject({
			status: "won",
			amountCents: 1500,
		});
	});

	it("[SM-9-read-your-writes] the seller's commands are in D1 when they return", async () => {
		const sale = await makeSale({ terms: { reviewEveryClaim: true } });
		const entry = entryOf(await claim(sale, await addUser()));
		expect(entry.status).toBe("open");
		value(
			await engine.awardEntry({
				saleId: sale.saleId,
				itemId: sale.itemIds[0]!,
				entryId: entry.id,
				sellerId: sale.sellerId,
			}),
		);
		// Straight from D1, without waiting for the outbox: the win and its draft invoice.
		const row = await db.prepare("SELECT status FROM entries WHERE id = ?1").bind(entry.id).first();
		expect(row).toEqual({ status: "won" });
		const invoices = await db
			.prepare("SELECT status FROM invoices WHERE sale_id = ?1")
			.bind(sale.saleId)
			.all();
		expect(invoices.results).toEqual([{ status: "draft" }]);
	});

	it("[SM-9-buyer-cache] a block or a ban reaches the engine at once through buyerChanged; otherwise within 30 s", async () => {
		const sale = await makeSale({ items: [{}, {}, {}, {}] });
		const buyer = await addUser();
		value(await claim(sale, buyer, sale.itemIds[0]));

		await db
			.prepare(
				"INSERT INTO blocks (seller_id, blocked_user_id, reason, created_at) VALUES (?1, ?2, 'messages', 1)",
			)
			.bind(sale.sellerId, buyer)
			.run();
		// The engine still has the buyer's standing from the first claim.
		value(await claim(sale, buyer, sale.itemIds[1]));
		expect(await engine.buyerChanged({ userId: buyer, sellerId: sale.sellerId })).toEqual({
			ok: true,
			value: 1,
		});
		expect(rejection(await claim(sale, buyer, sale.itemIds[2]))).toBe("buyer_blocked");

		// A ban: the sales the buyer has entries in are told (D1 has those entries once settled).
		const banned = await addUser();
		value(await claim(sale, banned, sale.itemIds[3]));
		await db.prepare("UPDATE users SET banned_at = 1 WHERE id = ?1").bind(banned).run();
		await settle(sale.saleId);
		expect(await engine.buyerChanged({ userId: banned })).toEqual({ ok: true, value: 1 });
		expect(rejection(await claim(sale, banned, sale.itemIds[2]))).toBe("buyer_blocked");
	});

	it("[SM-9-local-store] keeps a claimed item's price and quantity, and writes them back over a late edit (D40)", async () => {
		const sale = await makeSale({ items: [{ priceCents: 4000 }] });
		value(await claim(sale, await addUser()));
		const itemId = sale.itemIds[0]!;
		await settle(sale.saleId);
		// An edit that passed the web Worker's check just before the claim reached D1.
		await db
			.prepare(
				"UPDATE items SET price_cents = 9999, quantity = 5, title = 'Renamed', version = version + 1 WHERE id = ?1",
			)
			.bind(itemId)
			.run();
		expect(await engine.listingsChanged({ saleId: sale.saleId, sellerId: sale.sellerId })).toEqual({
			ok: true,
			value: true,
		});
		await settle(sale.saleId);
		const row = await db
			.prepare("SELECT price_cents, quantity, title, version FROM items WHERE id = ?1")
			.bind(itemId)
			.first();
		expect(row).toMatchObject({ price_cents: 4000, quantity: 1, title: "Renamed", version: 2 });
		const [mine] = await localRows(
			sale.saleId,
			"SELECT price_cents, title, version FROM items WHERE id = ?1",
			itemId,
		);
		expect(mine).toEqual({ price_cents: 4000, title: "Renamed", version: 2 });
	});
});

describe("after a D1 restore", () => {
	it("[SM-9-hydrate] an admin reloads every open sale's engine from D1; anyone else can't", async () => {
		const sale = await makeSale({ items: [{ quantity: 1 }] });
		const [ann, bob] = [await addUser(), await addUser()];
		const won = entryOf(await claim(sale, ann));
		await settle(sale.saleId);
		// The restore rewound D1 to before Ann's claim.
		await db.batch([
			db.prepare("DELETE FROM invoice_lines WHERE entry_id = ?1").bind(won.id),
			db.prepare("DELETE FROM invoices WHERE sale_id = ?1").bind(sale.saleId),
			db.prepare("DELETE FROM entries WHERE id = ?1").bind(won.id),
			db.prepare("UPDATE items SET units_won = 0, state = 'available' WHERE id = ?1").bind(sale.itemIds[0]),
		]);
		expect(await engine.rehydrateSales({ adminId: ann })).toEqual({ ok: true, value: null });
		const admin = await addUser();
		await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?1").bind(admin).run();
		const reloaded = await engine.rehydrateSales({ adminId: admin });
		expect(reloaded.ok && reloaded.value).toBeGreaterThanOrEqual(1);
		// The engine follows D1 again: the unit is free, so Bob wins it.
		expect(entryOf(await claim(sale, bob)).status).toBe("won");
	});
});

/** A D1 stand-in that records what a flush sends, and can refuse a batch. */
function recordingD1(options: { failFirst?: boolean } = {}) {
	const batches: Array<Array<{ sql: string; params: unknown[] }>> = [];
	let fail = options.failFirst ?? false;
	const d1 = {
		prepare: (sql: string) => ({ sql, bind: (...params: unknown[]) => ({ sql, params }) }),
		batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
			if (fail) {
				fail = false;
				throw new Error("D1 DB is overloaded");
			}
			batches.push(statements);
			return [];
		},
	};
	return { d1: d1 as unknown as D1Database, batches };
}

/** A fresh engine's SQLite with the local tables and one item copied in. */
async function scratch(run: (sql: SqlStorage, storage: DurableObjectStorage) => Promise<void>) {
	const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName(uid("outbox")));
	await runInDurableObject(stub, async (_i, state) => {
		const sql = state.storage.sql;
		ensureLocalSchema(sql);
		withoutCapture(sql, () =>
			sql.exec(
				`INSERT INTO items (id, sale_id, sort_order, game_id, title, price_cents, quantity, created_at, updated_at)
				VALUES ('i1', 's1', 0, 'pokemon', 'Card', 100, 1, 1, 1)`,
			),
		);
		await run(sql, state.storage);
	});
}

describe("the outbox", () => {
	it("[SM-9-outbox] writes each changed row once, in commit order, then sends the events", async () => {
		await scratch(async (sql, storage) => {
			for (const version of [1, 2, 3]) sql.exec("UPDATE items SET version = ?1 WHERE id = 'i1'", version);
			sql.exec(
				`INSERT INTO entries (id, item_id, user_id, kind, amount_cents, status, created_at) VALUES ('e1', 'i1', 'u1', 'claim', 100, 'won', 1)`,
			);
			sql.exec("UPDATE entries SET status = 'won' WHERE id = 'e1'");
			sql.exec(`INSERT INTO _outbox (kind, payload) VALUES ('events', '[{"type":"entry_won"}]')`);
			sql.exec(`INSERT INTO _outbox (kind, payload) VALUES ('events', '[{"type":"entry_placed"}]')`);
			expect(pendingOutbox(sql)).toBe(7);
			const { d1, batches } = recordingD1();
			const sent: unknown[] = [];
			const more = await flushOutbox({ sql, storage, d1, send: async (events) => void sent.push(events) });
			expect(more).toBe(false);
			expect(batches).toHaveLength(1);
			const statements = batches[0]!;
			expect(statements.map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
				"UPDATE items SET",
				'INSERT INTO "entries"',
			]);
			// The item's latest state, once.
			expect(statements[0]!.params.slice(0, 3)).toEqual(["i1", "available", 3]);
			expect(sent).toEqual([[{ type: "entry_won" }, { type: "entry_placed" }]]);
			expect(pendingOutbox(sql)).toBe(0);
		});
	});

	it("[SM-9-outbox] a refused batch keeps everything and sends no events; the next flush delivers", async () => {
		await scratch(async (sql, storage) => {
			sql.exec("UPDATE items SET version = 1 WHERE id = 'i1'");
			sql.exec(`INSERT INTO _outbox (kind, payload) VALUES ('events', '[{"type":"entry_won"}]')`);
			const { d1, batches } = recordingD1({ failFirst: true });
			const sent: unknown[] = [];
			const send = async (events: unknown) => void sent.push(events);
			await expect(flushOutbox({ sql, storage, d1, send })).rejects.toThrow(/overloaded/);
			expect(pendingOutbox(sql)).toBe(2);
			expect(sent).toEqual([]);
			expect(await flushOutbox({ sql, storage, d1, send })).toBe(false);
			expect(batches).toHaveLength(1);
			expect(sent).toEqual([[{ type: "entry_won" }]]);
			expect(pendingOutbox(sql)).toBe(0);
		});
	});

	it("[SM-9-outbox] rows copied in from D1 aren't sent back", async () => {
		await scratch(async (sql) => {
			// The scratch item was copied in with capture off.
			expect(pendingOutbox(sql)).toBe(0);
		});
	});
});
