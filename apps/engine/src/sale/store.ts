import {
	deriveItemState,
	pendingTimers,
	subtotal,
	total,
	unitsHeld,
	type Entry,
	type Invoice,
	type Item,
	type Millis,
	type Sale,
	type SaleStatus,
	type Tier,
	type Timer,
} from "@claimsale/core";
import { uuidv7 } from "uuidv7";
import {
	tierOf,
	toInvoice,
	toItem,
	type BuyerRow,
	type EntryRow,
	type InvoiceLineRow,
	type InvoiceRow,
	type ItemRow,
	type SaleRow,
} from "./rows.ts";
import { readSaleSettings, type SaleSettings } from "./settings.ts";

/**
 * The engine's D1 storage adapter (STATE_MACHINES §9). Reads go out as one
 * `db.batch()` where possible; every command's writes go out as **one** batch (a
 * transaction) holding the item version checks, the entry / invoice rows and the
 * audit row. If load testing ever moves live entry state into the Durable Object's
 * own SQLite, only this file changes.
 */

const PRO_SQL = (userParam: string, side: "seller" | "buyer", nowParam: string) =>
	`EXISTS (SELECT 1 FROM subscriptions sub JOIN plans p ON p.id = sub.plan_id
		WHERE sub.user_id = ${userParam} AND sub.status IN ('active', 'trialing', 'granted')
		AND (sub.current_period_end IS NULL OR sub.current_period_end > ${nowParam})
		AND json_extract(p.limits, '$.${side}') = 'pro')`;

export interface SaleRecord {
	readonly id: string;
	readonly sellerId: string;
	readonly sellerTier: Tier;
	readonly title: string;
	readonly sale: Sale;
	readonly settings: SaleSettings;
}

export interface LoadedItem {
	readonly title: string;
	readonly version: number;
	readonly item: Item;
}

export interface BuyerRecord {
	readonly id: string;
	readonly tier: Tier;
	readonly blocked: boolean;
	readonly emailVerified: boolean;
	readonly accountCreatedAt: Millis;
}

/** A version check failed: something else wrote the item (or invoice, or sale) first. */
export class WriteConflict extends Error {
	override readonly name = "WriteConflict";
}

const isConflict = (error: unknown) =>
	error instanceof Error && /NOT NULL constraint failed: (items\.version|invoices\.updated_at|sales\.status)/.test(error.message);

const ids = (values: Iterable<string>) => JSON.stringify([...new Set(values)]);

export function saleQuery(db: D1Database, saleId: string, now: Millis) {
	return db
		.prepare(
			`SELECT s.id, s.seller_id, s.status, s.live_at, s.closes_at, s.title, s.terms, s.shipping,
				(SELECT count(*) FROM items WHERE items.sale_id = s.id) AS item_count,
				${PRO_SQL("s.seller_id", "seller", "?2")} AS seller_pro
			FROM sales s WHERE s.id = ?1`,
		)
		.bind(saleId, now);
}

export function toSaleRecord(row: SaleRow): SaleRecord {
	const sellerTier = tierOf(row.seller_pro);
	return {
		id: row.id,
		sellerId: row.seller_id,
		sellerTier,
		title: row.title,
		sale: {
			status: row.status,
			liveAt: row.live_at,
			closesAt: row.closes_at,
			sellerTier,
			itemCount: row.item_count,
		},
		settings: readSaleSettings(row.terms, row.shipping, sellerTier),
	};
}

const ITEM_COLUMNS = `id, sale_id, title, price_cents, quantity, per_buyer_limit, offers_mode, min_offer_cents,
	state, withdrawn_at, decision_deadline, offers_lapse_at, units_won, version`;

export function itemsQuery(db: D1Database, saleId: string, itemIds: readonly string[] | "all") {
	return itemIds === "all"
		? db.prepare(`SELECT ${ITEM_COLUMNS} FROM items WHERE sale_id = ?1 ORDER BY sort_order, id`).bind(saleId)
		: db
				.prepare(
					`SELECT ${ITEM_COLUMNS} FROM items WHERE sale_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
				)
				.bind(saleId, ids(itemIds));
}

export function entriesQuery(db: D1Database, saleId: string, itemIds: readonly string[] | "all") {
	return itemIds === "all"
		? db
				.prepare(
					"SELECT e.* FROM entries e JOIN items i ON i.id = e.item_id WHERE i.sale_id = ?1 ORDER BY e.created_at, e.id",
				)
				.bind(saleId)
		: db
				.prepare("SELECT * FROM entries WHERE item_id IN (SELECT value FROM json_each(?1)) ORDER BY created_at, id")
				.bind(ids(itemIds));
}

export function buyerQuery(db: D1Database, buyerId: string, sellerId: string, now: Millis) {
	return db
		.prepare(
			`SELECT u.id, u.email_verified, u.created_at,
				EXISTS (SELECT 1 FROM blocks b WHERE b.seller_id = ?2 AND b.blocked_user_id = u.id) AS blocked,
				${PRO_SQL("u.id", "buyer", "?3")} AS buyer_pro
			FROM users u WHERE u.id = ?1`,
		)
		.bind(buyerId, sellerId, now);
}

export function toBuyer(row: BuyerRow): BuyerRecord {
	return {
		id: row.id,
		tier: tierOf(row.buyer_pro),
		blocked: row.blocked === 1,
		emailVerified: row.email_verified === 1,
		accountCreatedAt: row.created_at,
	};
}

/** The tier a user has on one side, for actors that aren't the sale's seller. */
export async function loadTier(db: D1Database, userId: string, side: "seller" | "buyer", now: Millis) {
	const row = await db
		.prepare(`SELECT ${PRO_SQL("?1", side, "?2")} AS pro`)
		.bind(userId, now)
		.first<{ pro: number }>();
	return tierOf(row?.pro ?? 0);
}

export async function loadSale(db: D1Database, saleId: string, now: Millis): Promise<SaleRecord | undefined> {
	const row = await saleQuery(db, saleId, now).first<SaleRow>();
	return row && row.status !== "deleted" ? toSaleRecord(row) : undefined;
}

export function toLoadedItems(items: readonly ItemRow[], entries: readonly EntryRow[]): Map<string, LoadedItem> {
	return new Map(
		items.map((row) => [row.id, { title: row.title, version: row.version, item: toItem(row, entries) }]),
	);
}

/** The sale with some (or all) of its items and their entries, in one round trip. */
export async function loadSaleAndItems(
	db: D1Database,
	saleId: string,
	itemIds: readonly string[] | "all",
	now: Millis,
	buyer?: { readonly id: string },
): Promise<{ sale: SaleRecord | undefined; items: Map<string, LoadedItem>; buyer: BuyerRecord | undefined }> {
	const sale = await saleQuery(db, saleId, now).first<SaleRow>();
	if (!sale || sale.status === "deleted") return { sale: undefined, items: new Map(), buyer: undefined };
	const statements = [itemsQuery(db, saleId, itemIds), entriesQuery(db, saleId, itemIds)];
	if (buyer) statements.push(buyerQuery(db, buyer.id, sale.seller_id, now));
	const [items, entries, buyers] = await db.batch(statements);
	const buyerRow = (buyers?.results as BuyerRow[] | undefined)?.[0];
	return {
		sale: toSaleRecord(sale),
		items: toLoadedItems(items!.results as ItemRow[], entries!.results as EntryRow[]),
		buyer: buyerRow ? toBuyer(buyerRow) : undefined,
	};
}

export interface LoadedInvoice {
	readonly invoice: Invoice;
	readonly number: number | null;
	readonly updatedAt: Millis;
	/** invoice_lines.id by entry ID. */
	readonly lineIds: ReadonlyMap<string, string>;
}

export async function loadInvoices(
	db: D1Database,
	saleId: string,
	sellerTier: Tier,
): Promise<Map<string, LoadedInvoice>> {
	const [invoices, lines] = await db.batch([
		db.prepare("SELECT * FROM invoices WHERE sale_id = ?1 ORDER BY created_at, id").bind(saleId),
		db
			.prepare(
				"SELECT l.* FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.sale_id = ?1 ORDER BY l.created_at, l.id",
			)
			.bind(saleId),
	]);
	const lineRows = lines!.results as InvoiceLineRow[];
	return new Map(
		(invoices!.results as InvoiceRow[]).map((row) => [
			row.id,
			{
				invoice: toInvoice(row, lineRows, sellerTier),
				number: row.invoice_number,
				updatedAt: row.updated_at,
				lineIds: new Map(lineRows.filter((l) => l.invoice_id === row.id).map((l) => [l.entry_id, l.id])),
			},
		]),
	);
}

// ---------------------------------------------------------------------------
// The unit of work

export interface AuditRecord {
	readonly action: string;
	readonly actorId: string;
	readonly itemId: string | null;
	readonly input?: Record<string, unknown> | undefined;
	readonly events: readonly unknown[];
}

export interface SaleChange {
	readonly expected: SaleStatus;
	readonly next: Sale;
	readonly publishedAt?: Millis;
	/** Free sellers: re-check the active-sale cap inside the write (SM-2-free-sale-cap). */
	readonly activeSaleCap?: number;
}

/**
 * Everything one command read and changed. `commit()` turns the differences into
 * one D1 batch: version-checked item updates, entry and invoice upserts, the extra
 * rows the command added (rescinds, take-backs) and its audit row.
 */
export class Work {
	readonly items = new Map<string, { readonly before: LoadedItem; after: Item }>();
	invoices: Map<string, LoadedInvoice> | undefined;
	readonly invoiceChanges = new Map<string, Invoice>();
	readonly extra: D1PreparedStatement[] = [];
	readonly audits: AuditRecord[] = [];
	readonly events: Array<Record<string, unknown>> = [];
	saleChange: SaleChange | undefined;

	constructor(
		readonly db: D1Database,
		readonly sale: SaleRecord,
		readonly now: Millis,
	) {}

	addItems(items: ReadonlyMap<string, LoadedItem>): void {
		for (const [id, before] of items) if (!this.items.has(id)) this.items.set(id, { before, after: before.item });
	}

	item(itemId: string): Item | undefined {
		return this.items.get(itemId)?.after;
	}

	title(itemId: string): string {
		return this.items.get(itemId)?.before.title ?? "";
	}

	setItem(item: Item): void {
		const slot = this.items.get(item.id);
		if (!slot) throw new Error(`item ${item.id} was not loaded`);
		slot.after = item;
	}

	/** The sale status the write will leave (derived item states depend on it). */
	get saleStatus(): SaleStatus {
		return this.saleChange?.next.status ?? this.sale.sale.status;
	}

	invoice(invoiceId: string): Invoice | undefined {
		return this.invoiceChanges.get(invoiceId) ?? this.invoices?.get(invoiceId)?.invoice;
	}

	/** Every invoice of the sale as it will be after the write. */
	allInvoices(): Invoice[] {
		const out = new Map<string, Invoice>();
		for (const [id, loaded] of this.invoices ?? []) out.set(id, loaded.invoice);
		for (const [id, invoice] of this.invoiceChanges) out.set(id, invoice);
		return [...out.values()];
	}

	/** The invoice (not cancelled) holding the entry's line. */
	invoiceFor(entryId: string): Invoice | undefined {
		return this.allInvoices().find(
			(inv) => inv.status !== "cancelled" && inv.lines.some((l) => l.entryId === entryId),
		);
	}

	setInvoice(invoice: Invoice): void {
		this.invoiceChanges.set(invoice.id, invoice);
	}

	audit(record: AuditRecord): void {
		this.audits.push(record);
	}

	event(event: Record<string, unknown>): void {
		this.events.push(event);
	}

	changedEntries(itemId: string): Entry[] {
		const slot = this.items.get(itemId);
		if (!slot) return [];
		const before = new Map(slot.before.item.entries.map((e) => [e.id, e]));
		return slot.after.entries.filter((e) => !sameEntry(before.get(e.id), e));
	}

	changedItemIds(): string[] {
		return [...this.items]
			.filter(([, slot]) => slot.after !== slot.before.item || this.saleChange !== undefined)
			.map(([id]) => id);
	}

	/** Timers of what this write touched, to re-arm the sale's alarm (SM-7-single-alarm). */
	touchedTimers(): Timer[] {
		const sale = this.saleChange?.next ?? this.sale.sale;
		const items = [...this.items.values()].map((slot) => slot.after);
		return pendingTimers(sale, items, [...this.invoiceChanges.values()]);
	}

	statements(): D1PreparedStatement[] {
		const { db, now } = this;
		const out: D1PreparedStatement[] = [];
		if (this.saleChange) out.push(saleUpdate(db, this.sale, this.saleChange, now));
		for (const id of this.changedItemIds()) {
			const slot = this.items.get(id)!;
			const after = slot.after;
			out.push(
				db
					.prepare(
						`UPDATE items SET version = CASE WHEN version = ?1 THEN version + 1 ELSE NULL END,
							state = ?2, decision_deadline = ?3, offers_lapse_at = ?4,
							withdrawn_at = CASE WHEN ?5 THEN COALESCE(withdrawn_at, ?7) ELSE NULL END,
							units_won = ?6, updated_at = ?7
						WHERE id = ?8`,
					)
					.bind(
						slot.before.version,
						deriveItemState(after, this.saleStatus),
						after.decisionDeadline,
						after.offersLapseAt,
						after.withdrawn ? 1 : 0,
						unitsHeld(after),
						now,
						id,
					),
			);
			for (const entry of this.changedEntries(id)) out.push(entryUpsert(db, id, entry));
		}
		for (const [id, invoice] of this.invoiceChanges) out.push(...invoiceWrites(this, id, invoice));
		out.push(...this.extra);
		for (const audit of this.audits) out.push(this.auditInsert(audit));
		return out;
	}

	/** The audit row's data: the command, its events and the full after-state of what it changed (SM-9-audit). */
	auditData(audit: AuditRecord): Record<string, unknown> {
		const items = audit.itemId === null ? this.changedItemIds() : [audit.itemId];
		return {
			...(audit.input ? { input: audit.input } : {}),
			events: audit.events,
			...(this.saleChange
				? {
						sale: {
							status: this.saleChange.next.status,
							liveAt: this.saleChange.next.liveAt,
							closesAt: this.saleChange.next.closesAt,
						},
					}
				: {}),
			items: items
				.filter((id) => this.items.has(id))
				.map((id) => {
					const after = this.items.get(id)!.after;
					return {
						id,
						decisionDeadline: after.decisionDeadline,
						offersLapseAt: after.offersLapseAt,
						withdrawn: after.withdrawn,
						entries: this.changedEntries(id),
					};
				}),
			invoices: [...this.invoiceChanges.values()],
		};
	}

	auditInsert(audit: AuditRecord): D1PreparedStatement {
		return this.db
			.prepare(
				"INSERT INTO audit_log (id, sale_id, item_id, actor_id, action, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
			)
			.bind(
				uuidv7(),
				this.sale.id,
				audit.itemId,
				audit.actorId,
				audit.action,
				JSON.stringify(this.auditData(audit)),
				this.now,
			);
	}

	/** Writes everything in one batch. Throws WriteConflict when a version check fails. */
	async commit(): Promise<void> {
		const statements = this.statements();
		if (statements.length === 0) return;
		try {
			await this.db.batch(statements);
		} catch (error) {
			if (isConflict(error)) throw new WriteConflict("The item changed during the write");
			throw error;
		}
	}
}

function sameEntry(a: Entry | undefined, b: Entry): boolean {
	if (a === undefined) return false;
	if (a === b) return true;
	return (Object.keys(b) as (keyof Entry)[]).every((key) => a[key] === b[key]);
}

function entryUpsert(db: D1Database, itemId: string, e: Entry): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO entries (id, item_id, user_id, kind, amount_cents, status, rank_override, counter_cents,
				counter_expires_at, won_at, ended_at, ended_reason, ended_by, created_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
			ON CONFLICT (id) DO UPDATE SET amount_cents = excluded.amount_cents, status = excluded.status,
				rank_override = excluded.rank_override, counter_cents = excluded.counter_cents,
				counter_expires_at = excluded.counter_expires_at, won_at = excluded.won_at,
				ended_at = excluded.ended_at, ended_reason = excluded.ended_reason, ended_by = excluded.ended_by`,
		)
		.bind(
			e.id,
			itemId,
			e.buyerId,
			e.kind,
			e.amountCents,
			e.status,
			e.rankOverride,
			e.counterCents,
			e.counterExpiresAt,
			e.wonAt,
			e.endedAt,
			e.endedReason,
			e.endedBy,
			e.createdAt,
		);
}

function saleUpdate(db: D1Database, sale: SaleRecord, change: SaleChange, now: Millis): D1PreparedStatement {
	// A status that changed under us, or (free sellers) a cap another sale filled
	// meanwhile, sets status to NULL: the NOT NULL constraint aborts the whole batch.
	const cap = change.activeSaleCap ?? null;
	return db
		.prepare(
			`UPDATE sales SET
				status = CASE WHEN status = ?1 AND (?2 IS NULL OR (SELECT count(*) FROM sales o
					WHERE o.seller_id = sales.seller_id AND o.id != sales.id AND o.status IN ('scheduled', 'live')) < ?2)
					THEN ?3 ELSE NULL END,
				live_at = ?4, closes_at = ?5, published_at = COALESCE(?6, published_at), updated_at = ?7
			WHERE id = ?8`,
		)
		.bind(
			change.expected,
			cap,
			change.next.status,
			change.next.liveAt,
			change.next.closesAt,
			change.publishedAt ?? null,
			now,
			sale.id,
		);
}

function invoiceWrites(work: Work, id: string, invoice: Invoice): D1PreparedStatement[] {
	const { db, now } = work;
	const loaded = work.invoices?.get(id);
	const out: D1PreparedStatement[] = [];
	const values = [
		invoice.status,
		subtotal(invoice),
		invoice.shippingCents,
		invoice.adjustmentCents,
		total(invoice),
		invoice.gmvCents,
		invoice.shippingOptionId,
		invoice.paymentRef,
		invoice.tracking?.carrier ?? null,
		invoice.tracking?.number ?? null,
		invoice.sentAt,
		invoice.dueAt,
		invoice.paidAt,
		invoice.status === "paid" && loaded?.invoice.status !== "paid" ? now : null,
		invoice.shippedAt,
		invoice.completedAt,
		now,
	] as const;
	if (!loaded) {
		out.push(
			db
				.prepare(
					`INSERT INTO invoices (status, subtotal_cents, shipping_cents, adjustment_cents, total_cents, gmv_cents,
						shipping_option_id, payment_ref, carrier, tracking_number, sent_at, due_at, buyer_paid_at, paid_at,
						shipped_at, completed_at, updated_at, id, sale_id, buyer_id, seller_id, created_at, invoice_number)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?17,
						(SELECT COALESCE(MAX(invoice_number), 0) + 1 FROM invoices WHERE seller_id = ?21))`,
				)
				.bind(...values, id, work.sale.id, invoice.buyerId, invoice.sellerId),
		);
	} else {
		out.push(
			db
				.prepare(
					`UPDATE invoices SET status = ?1, subtotal_cents = ?2, shipping_cents = ?3, adjustment_cents = ?4,
						total_cents = ?5, gmv_cents = ?6, shipping_option_id = ?7, payment_ref = ?8, carrier = ?9,
						tracking_number = ?10, sent_at = ?11, due_at = ?12, buyer_paid_at = ?13,
						paid_at = COALESCE(?14, paid_at), shipped_at = ?15, completed_at = ?16,
						updated_at = CASE WHEN updated_at = ?18 THEN ?17 ELSE NULL END
					WHERE id = ?19`,
				)
				.bind(...values, loaded.updatedAt, id),
		);
	}
	const before = new Map((loaded?.invoice.lines ?? []).map((l) => [l.entryId, l]));
	const after = new Set(invoice.lines.map((l) => l.entryId));
	for (const line of invoice.lines) {
		const old = before.get(line.entryId);
		if (!old) {
			out.push(
				db
					.prepare(
						"INSERT INTO invoice_lines (id, invoice_id, entry_id, description, amount_cents, refund_owed, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
					)
					.bind(uuidv7(), id, line.entryId, line.description, line.amountCents, line.refundOwed ? 1 : 0, now),
			);
		} else if (old.refundOwed !== line.refundOwed) {
			out.push(
				db
					.prepare("UPDATE invoice_lines SET refund_owed = ?1 WHERE invoice_id = ?2 AND entry_id = ?3")
					.bind(line.refundOwed ? 1 : 0, id, line.entryId),
			);
		}
	}
	for (const entryId of before.keys()) {
		if (!after.has(entryId)) {
			out.push(
				db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?1 AND entry_id = ?2").bind(id, entryId),
			);
		}
	}
	return out;
}

export const newId = (): string => uuidv7();
