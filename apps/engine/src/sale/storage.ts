import type { Millis, Tier } from "@claimsale/core";
import { localTable, LOCAL_TABLES } from "@claimsale/db/local";
import {
	clearLocal,
	copyRows,
	ensureLocalSchema,
	LocalD1,
	readMeta,
	sqlValue,
	withoutCapture,
	writeMeta,
} from "./local-db.ts";
import { flushOutbox, pendingOutbox } from "./outbox.ts";
import { rowsOf, type BuyerRow } from "./rows.ts";
import {
	buyerQuery,
	entriesQuery,
	isConflict,
	itemsQuery,
	loadInvoices as loadInvoicesFrom,
	loadSale as loadSaleFrom,
	loadSaleAndItems as loadSaleAndItemsFrom,
	saleUpdate,
	toBuyer,
	toLoadedItems,
	WriteConflict,
	type BuyerRecord,
	type LoadedInvoice,
	type LoadedItem,
	type SaleRecord,
	type Work,
} from "./store.ts";

/**
 * Where a SaleEngine keeps its sale (STATE_MACHINES §9). Two adapters, one interface:
 *
 * - `d1`: every read and write goes to D1, as before WS-N (the rollback switch).
 * - `local`: the sale's items, entries, invoices, rescinds and take-backs live in the
 *   object's own SQLite; D1 is their read model, kept up to date by the outbox. Only
 *   cross-sale data (the sale row, users, plans, blocks) is read from D1, briefly cached.
 *
 * @spec SM-9-local-store
 */
export interface SaleStorage {
	readonly mode: "local" | "d1";
	/** The sale's own tables: the object's SQLite, or D1. */
	readonly local: D1Database;
	/** Everything else (users, plans, other sales, photos, jobs). */
	readonly d1: D1Database;
	/** Makes the sale's rows available (the local adapter copies them in from D1 once). */
	ready(saleId: string): Promise<void>;
	/** The sale row with its seller's tier. `fresh` skips any cache (lifecycle commands). */
	loadSale(saleId: string, now: Millis, options?: { fresh?: boolean }): Promise<SaleRecord | undefined>;
	loadSaleAndItems(
		saleId: string,
		itemIds: readonly string[] | "all",
		now: Millis,
		buyer?: { readonly id: string },
	): Promise<{
		sale: SaleRecord | undefined;
		items: Map<string, LoadedItem>;
		buyer: BuyerRecord | undefined;
	}>;
	loadInvoices(saleId: string, sellerTier: Tier): Promise<Map<string, LoadedInvoice>>;
	/** Writes a command's work as one transaction. Throws WriteConflict on a failed check. */
	commit(work: Work): Promise<void>;
	/** After a commit: the d1 adapter publishes its events, the local one starts a flush. */
	committed(work: Work): void;
	/** Waits until D1 has every committed write (read-your-writes for the web). */
	settle(): Promise<void>;
	/** The seller changed items in D1 (the web editor, an import): copy them in. */
	refreshItems(saleId: string): Promise<void>;
	/** Forgets cached rows: the sale's, one buyer's, or every buyer's. */
	forget(what: { sale?: boolean; buyerId?: string; allBuyers?: boolean }): void;
	/** When the object should wake to retry an unfinished flush; null when nothing waits. */
	retryAt(now: Millis): Millis | null;
}

export interface StorageHooks {
	/** Sends a sale's events to the notifications queue; throws when they aren't queued. */
	readonly send: (saleId: string, events: ReadonlyArray<Record<string, unknown>>) => Promise<void>;
	/** Publishes without waiting (the d1 adapter's fire-and-forget after a commit). */
	readonly publish: (saleId: string, events: ReadonlyArray<Record<string, unknown>>) => void;
	/** Keeps the flush alive past the request that started it. */
	readonly waitUntil: (promise: Promise<unknown>) => void;
	/** Asks for an alarm by `at` (to retry a flush). */
	readonly wakeBy: (at: Millis) => Promise<void>;
	readonly warn: (message: string, error: unknown) => void;
}

/** Today's adapter: D1 is the sale's only store. */
export class D1SaleStorage implements SaleStorage {
	readonly mode = "d1";
	readonly local: D1Database;

	constructor(
		readonly d1: D1Database,
		readonly saleId: () => string | undefined,
		readonly hooks: Pick<StorageHooks, "publish">,
	) {
		this.local = d1;
	}

	async ready(): Promise<void> {}

	loadSale(saleId: string, now: Millis) {
		return loadSaleFrom(this.d1, saleId, now);
	}

	loadSaleAndItems(
		saleId: string,
		itemIds: readonly string[] | "all",
		now: Millis,
		buyer?: { readonly id: string },
	) {
		return loadSaleAndItemsFrom(this.d1, saleId, itemIds, now, buyer);
	}

	loadInvoices(saleId: string, sellerTier: Tier) {
		return loadInvoicesFrom(this.d1, saleId, sellerTier);
	}

	async commit(work: Work): Promise<void> {
		const db = this.d1;
		const statements = [
			...(work.saleChange ? [saleUpdate(db, work.sale, work.saleChange, work.now)] : []),
			...work.statements(),
			...work.remote.map((r) => db.prepare(r.sql).bind(...r.params)),
		];
		if (statements.length === 0) return;
		try {
			await db.batch(statements);
		} catch (error) {
			if (isConflict(error)) throw new WriteConflict("The item changed during the write");
			throw error;
		}
	}

	committed(work: Work): void {
		const saleId = this.saleId();
		if (saleId !== undefined && work.events.length > 0) this.hooks.publish(saleId, work.events);
	}

	async settle(): Promise<void> {}
	async refreshItems(): Promise<void> {}
	forget(): void {}
	retryAt(): Millis | null {
		return null;
	}
}

/** How long a cached sale row (status, terms, the seller's tier) is trusted. */
export const SALE_CACHE_MS = 2_000;
/** How long a cached buyer record (verified, banned, blocked, tier) is trusted. */
export const BUYER_CACHE_MS = 30_000;
/** How soon a failed flush is tried again. */
export const FLUSH_RETRY_MS = 5_000;

/**
 * The sale lives in the object's SQLite; D1 follows through the outbox.
 *
 * @spec SM-9-local-store
 * @spec SM-9-buyer-cache — a buyer's standing is read from D1 at most every 30 s, or again
 * as soon as the web Worker reports a block, an unblock or a ban (`buyerChanged`).
 */
export class LocalSaleStorage implements SaleStorage {
	readonly mode = "local";
	readonly local: D1Database;
	readonly #db: LocalD1;
	readonly #raw: SqlStorage;
	#schema = false;
	#ready: Promise<void> | undefined;
	#sale: { readonly record: SaleRecord | undefined; readonly at: Millis } | undefined;
	readonly #buyers = new Map<string, { readonly record: BuyerRecord | undefined; readonly at: Millis }>();
	#flushing: Promise<void> | undefined;
	#again = false;
	#failedAt: Millis | null = null;

	constructor(
		readonly ctx: DurableObjectState,
		readonly d1: D1Database,
		readonly saleId: () => string | undefined,
		readonly hooks: StorageHooks,
		readonly clock: () => Millis,
	) {
		this.#raw = ctx.storage.sql;
		this.#db = new LocalD1(this.#raw, ctx.storage);
		this.local = this.#db.asD1();
	}

	/** The object's SQLite, with the local tables created on first use (not every object serves a sale). */
	get #sql(): SqlStorage {
		if (!this.#schema) {
			ensureLocalSchema(this.#raw);
			this.#schema = true;
		}
		return this.#raw;
	}

	/**
	 * Copies the sale's rows in from D1 the first time this object serves it.
	 *
	 * @spec SM-9-hydrate
	 */
	ready(saleId: string): Promise<void> {
		this.#ready ??= this.#hydrate(saleId).catch((error: unknown) => {
			this.#ready = undefined;
			throw error;
		});
		return this.#ready;
	}

	async #hydrate(saleId: string): Promise<void> {
		if (readMeta(this.#sql, "hydrated_at") !== null) return;
		const db = this.d1;
		const sale = "SELECT id FROM items WHERE sale_id = ?1";
		const [items, entries, invoices, lines, rescinds, takebacks] = await db.batch([
			db.prepare("SELECT * FROM items WHERE sale_id = ?1").bind(saleId),
			db.prepare(`SELECT * FROM entries WHERE item_id IN (${sale})`).bind(saleId),
			db.prepare("SELECT * FROM invoices WHERE sale_id = ?1").bind(saleId),
			db
				.prepare(
					"SELECT * FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE sale_id = ?1)",
				)
				.bind(saleId),
			db
				.prepare(
					`SELECT * FROM rescinds WHERE entry_id IN (SELECT id FROM entries WHERE item_id IN (${sale}))`,
				)
				.bind(saleId),
			db
				.prepare(
					`SELECT * FROM takeback_requests WHERE entry_id IN (SELECT id FROM entries WHERE item_id IN (${sale}))`,
				)
				.bind(saleId),
		]);
		this.ctx.storage.transactionSync(() =>
			withoutCapture(this.#sql, () => {
				// Another request may have hydrated while D1 answered.
				if (readMeta(this.#sql, "hydrated_at") !== null) return;
				copyRows(this.#sql, localTable("items"), anyRows(items));
				copyRows(this.#sql, localTable("entries"), anyRows(entries));
				copyRows(this.#sql, localTable("invoices"), anyRows(invoices));
				copyRows(this.#sql, localTable("invoice_lines"), anyRows(lines));
				copyRows(this.#sql, localTable("rescinds"), anyRows(rescinds));
				copyRows(this.#sql, localTable("takeback_requests"), anyRows(takebacks));
				writeMeta(this.#sql, "sale_id", saleId);
				writeMeta(this.#sql, "hydrated_at", String(this.clock()));
			}),
		);
	}

	/**
	 * Drops the local copy and reads the sale from D1 again, after the outbox is empty:
	 * for repairs, and after D1 was restored (Time Travel).
	 *
	 * @spec SM-9-hydrate
	 */
	async rehydrate(saleId: string): Promise<void> {
		await this.settle();
		this.ctx.storage.transactionSync(() => withoutCapture(this.#sql, () => clearLocal(this.#sql)));
		this.#ready = undefined;
		this.forget({ sale: true, allBuyers: true });
		await this.ready(saleId);
	}

	async loadSale(saleId: string, now: Millis, options: { fresh?: boolean } = {}) {
		const cached = this.#sale;
		if (!options.fresh && cached && now - cached.at < SALE_CACHE_MS && now >= cached.at) return cached.record;
		const record = await loadSaleFrom(this.d1, saleId, now);
		this.#sale = { record, at: now };
		return record;
	}

	async #buyer(buyerId: string, saleId: string, now: Millis): Promise<BuyerRecord | undefined> {
		const cached = this.#buyers.get(buyerId);
		if (cached && now - cached.at < BUYER_CACHE_MS && now >= cached.at) return cached.record;
		const row = await buyerQuery(this.d1, buyerId, saleId, now).first<BuyerRow>();
		const record = row ? toBuyer(row) : undefined;
		if (this.#buyers.size >= 5_000) this.#buyers.clear();
		this.#buyers.set(buyerId, { record, at: now });
		return record;
	}

	async loadSaleAndItems(
		saleId: string,
		itemIds: readonly string[] | "all",
		now: Millis,
		buyer?: { readonly id: string },
	) {
		await this.ready(saleId);
		const sale = await this.loadSale(saleId, now);
		if (!sale) return { sale: undefined, items: new Map<string, LoadedItem>(), buyer: undefined };
		let items = await this.#loadItems(saleId, itemIds);
		// An item the web Worker added since: copy the sale's items in once, then look again.
		if (itemIds !== "all" && itemIds.some((id) => !items.has(id))) {
			await this.refreshItems(saleId);
			items = await this.#loadItems(saleId, itemIds);
		}
		return { sale, items, buyer: buyer ? await this.#buyer(buyer.id, saleId, now) : undefined };
	}

	async #loadItems(saleId: string, itemIds: readonly string[] | "all") {
		const [items, entries] = await this.local.batch([
			itemsQuery(this.local, saleId, itemIds),
			entriesQuery(this.local, saleId, itemIds),
		]);
		return toLoadedItems(rowsOf(items), rowsOf(entries));
	}

	async loadInvoices(saleId: string, sellerTier: Tier) {
		await this.ready(saleId);
		return loadInvoicesFrom(this.local, saleId, sellerTier);
	}

	/**
	 * The sale row changes in D1 first (its status check and the free seller's active-sale
	 * cap span other sales); the sale's own rows, the outbox rows and the events then commit
	 * locally in one transaction.
	 */
	async commit(work: Work): Promise<void> {
		if (work.saleChange) {
			try {
				await this.d1.batch([saleUpdate(this.d1, work.sale, work.saleChange, work.now)]);
			} catch (error) {
				if (isConflict(error)) throw new WriteConflict("The sale changed during the write");
				throw error;
			}
			this.#sale = undefined;
		}
		const statements = [
			...work.statements(),
			...work.remote.map((r) =>
				this.local
					.prepare("INSERT INTO _outbox (kind, payload) VALUES ('sql', ?1)")
					.bind(JSON.stringify({ sql: r.sql, params: r.params })),
			),
			...(work.events.length > 0
				? [
						this.local
							.prepare("INSERT INTO _outbox (kind, payload) VALUES ('events', ?1)")
							.bind(JSON.stringify(work.events)),
					]
				: []),
		];
		if (statements.length === 0) return;
		try {
			await this.local.batch(statements);
		} catch (error) {
			if (isConflict(error)) throw new WriteConflict("The item changed during the write");
			throw error;
		}
	}

	committed(): void {
		this.kick();
	}

	/**
	 * Starts copying the outbox to D1 unless a copy is running (it then runs again after).
	 * Commits that land meanwhile go out together in the next batch.
	 *
	 * @spec SM-9-outbox
	 */
	kick(): void {
		if (this.#flushing) {
			this.#again = true;
			return;
		}
		const run = this.#flushLoop().finally(() => {
			this.#flushing = undefined;
		});
		this.#flushing = run;
		this.hooks.waitUntil(run);
	}

	async #flushLoop(): Promise<void> {
		const saleId = this.saleId() ?? readMeta(this.#sql, "sale_id");
		if (saleId === null || saleId === undefined) return;
		try {
			// A few rounds per request (D1 limits queries per invocation); the alarm takes the rest.
			for (let round = 0; round < 8; round++) {
				this.#again = false;
				const more = await flushOutbox({
					sql: this.#sql,
					storage: this.ctx.storage,
					d1: this.d1,
					send: (events) => this.hooks.send(saleId, events),
				});
				if (!more && !this.#again) {
					this.#failedAt = null;
					return;
				}
			}
			await this.hooks.wakeBy(this.clock());
		} catch (error) {
			this.#failedAt = this.clock();
			this.hooks.warn("outbox flush failed; will retry", error);
			await this.hooks.wakeBy(this.clock() + FLUSH_RETRY_MS).catch(() => undefined);
		}
	}

	/**
	 * Waits until every committed write is in D1 (or a flush failed: then the write stays
	 * committed here, and the alarm retries).
	 *
	 * @spec SM-9-read-your-writes
	 */
	async settle(): Promise<void> {
		for (let i = 0; i < 20 && pendingOutbox(this.#sql) > 0; i++) {
			if (!this.#flushing) this.kick();
			await this.#flushing;
			if (this.#failedAt !== null) return;
		}
	}

	/**
	 * Copies the sale's items in from D1 after the web Worker changed them: new items are
	 * added, deleted ones (without entries) dropped, and the seller's fields updated. The
	 * engine's own fields stay; an item's version only grows. Once an item has entries its
	 * price and quantity are locked (D40), so a change that slipped in is written back.
	 */
	async refreshItems(saleId: string): Promise<void> {
		await this.ready(saleId);
		const { results } = await this.d1.prepare("SELECT * FROM items WHERE sale_id = ?1").bind(saleId).all();
		const remote = new Map(results.map((r) => [typeof r["id"] === "string" ? r["id"] : "", r]));
		const table = localTable("items");
		const owned = new Set<string>(ENGINE_ITEM_COLUMNS);
		this.ctx.storage.transactionSync(() => {
			const local = new Map(
				this.#sql
					.exec("SELECT * FROM items WHERE sale_id = ?1", saleId)
					.toArray()
					.map((r) => [typeof r["id"] === "string" ? r["id"] : "", r]),
			);
			const withEntries = new Set(
				this.#sql
					.exec<{ item_id: string }>(
						"SELECT DISTINCT item_id FROM entries WHERE item_id IN (SELECT id FROM items WHERE sale_id = ?1)",
						saleId,
					)
					.toArray()
					.map((r) => r.item_id),
			);
			const writeBack: Array<{ id: string; price: unknown; quantity: unknown }> = [];
			withoutCapture(this.#sql, () => {
				for (const [id, row] of remote) {
					const mine = local.get(id);
					if (!mine) {
						copyRows(this.#sql, table, [row]);
						continue;
					}
					const locked = withEntries.has(id);
					const sets: string[] = [];
					const values: unknown[] = [];
					for (const c of table.columns) {
						if (c.name === "id" || owned.has(c.name)) continue;
						if (locked && (c.name === "price_cents" || c.name === "quantity")) continue;
						sets.push(`"${c.name}" = ?${values.length + 2}`);
						values.push(row[c.name]);
					}
					sets.push(`version = MAX(version, ?${values.length + 2})`);
					values.push(row["version"]);
					this.#sql.exec(`UPDATE items SET ${sets.join(", ")} WHERE id = ?1`, id, ...values.map(sqlValue));
					if (
						locked &&
						(row["price_cents"] !== mine["price_cents"] || row["quantity"] !== mine["quantity"])
					) {
						writeBack.push({ id, price: mine["price_cents"], quantity: mine["quantity"] });
					}
				}
				for (const id of local.keys()) {
					if (!remote.has(id) && !withEntries.has(id)) this.#sql.exec("DELETE FROM items WHERE id = ?1", id);
				}
			});
			for (const w of writeBack) {
				this.#sql.exec(
					"INSERT INTO _outbox (kind, payload) VALUES ('sql', ?1)",
					JSON.stringify({
						sql: "UPDATE items SET price_cents = ?1, quantity = ?2 WHERE id = ?3",
						params: [w.price, w.quantity, w.id],
					}),
				);
			}
		});
		this.#sale = undefined;
		if (pendingOutbox(this.#sql) > 0) this.kick();
	}

	forget(what: { sale?: boolean; buyerId?: string; allBuyers?: boolean }): void {
		if (what.sale) this.#sale = undefined;
		if (what.allBuyers) this.#buyers.clear();
		if (what.buyerId !== undefined) this.#buyers.delete(what.buyerId);
	}

	retryAt(now: Millis): Millis | null {
		if (pendingOutbox(this.#sql) === 0) return null;
		return this.#failedAt === null ? now : this.#failedAt + FLUSH_RETRY_MS;
	}

	/** Rows waiting for D1 (tests and diagnostics). */
	pending(): number {
		return pendingOutbox(this.#sql);
	}

	/** Every local table's row count (tests and diagnostics). */
	counts(): Record<string, number> {
		return Object.fromEntries(
			LOCAL_TABLES.map((t) => [
				t.name,
				this.#sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${t.name}"`).one().n,
			]),
		);
	}
}

const anyRows = (result: D1Result | undefined) => rowsOf<Record<string, unknown>>(result);

/** The columns of `items` only the engine writes (STATE_MACHINES §3); the web Worker owns the rest. */
export const ENGINE_ITEM_COLUMNS = [
	"state",
	"version",
	"decision_deadline",
	"offers_lapse_at",
	"withdrawn_at",
	"units_won",
	"updated_at",
] as const;
