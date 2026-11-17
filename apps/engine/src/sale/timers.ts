import { pendingTimers, type Millis, type Timer } from "@claimsale/core";
import {
	rowsOf,
	toInvoice,
	type EntryRow,
	type InvoiceLineRow,
	type InvoiceRow,
	type ItemRow,
	type SaleRow,
} from "./rows.ts";
import { entriesQuery, itemsQuery, saleQuery, toLoadedItems, toSaleRecord } from "./store.ts";

/**
 * Every pending timer of one sale (STATE_MACHINES §7), read from D1 in one round trip.
 * The alarm handler runs the due ones and re-arms at the earliest of the rest.
 */
export async function loadTimers(db: D1Database, saleId: string, now: Millis): Promise<Timer[]> {
	const [sale, items, entries, invoices, lines] = await db.batch([
		saleQuery(db, saleId, now),
		itemsQuery(db, saleId, "all"),
		entriesQuery(db, saleId, "all"),
		db.prepare("SELECT * FROM invoices WHERE sale_id = ?1 AND status IN ('sent', 'shipped')").bind(saleId),
		db
			.prepare(
				"SELECT l.* FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.sale_id = ?1 AND i.status IN ('sent', 'shipped')",
			)
			.bind(saleId),
	]);
	const saleRow = rowsOf<SaleRow>(sale)[0];
	if (!saleRow || saleRow.status === "deleted") return [];
	const record = toSaleRecord(saleRow);
	const loaded = toLoadedItems(rowsOf<ItemRow>(items), rowsOf<EntryRow>(entries));
	const lineRows = rowsOf<InvoiceLineRow>(lines);
	return pendingTimers(
		record.sale,
		[...loaded.values()].map((l) => l.item),
		rowsOf<InvoiceRow>(invoices).map((row) => toInvoice(row, lineRows, record.sellerTier)),
	);
}

/**
 * Sales with a timer due by `before`, for the cron sweep (the backstop when an alarm
 * was lost). Mirrors `pendingTimers` in core.
 */
export async function salesWithDueTimers(
	db: D1Database,
	before: Millis,
	autocompleteAfter: Millis,
): Promise<string[]> {
	// D1 caps the terms of a compound SELECT, so each timer kind is its own query in one batch.
	const queries = [
		"SELECT id FROM sales WHERE (status = 'scheduled' AND live_at <= ?1) OR (status IN ('scheduled', 'live') AND closes_at <= ?1) LIMIT 500",
		"SELECT DISTINCT sale_id AS id FROM items WHERE decision_deadline <= ?1 LIMIT 500",
		"SELECT DISTINCT sale_id AS id FROM items WHERE offers_lapse_at <= ?1 LIMIT 500",
		`SELECT DISTINCT i.sale_id AS id FROM entries e JOIN items i ON i.id = e.item_id
			WHERE e.status = 'countered' AND e.counter_expires_at <= ?1 LIMIT 500`,
		"SELECT DISTINCT sale_id AS id FROM invoices WHERE status = 'sent' AND due_at <= ?1 LIMIT 500",
	];
	const results = await db.batch([
		...queries.map((sql) => db.prepare(sql).bind(before)),
		db
			.prepare(
				"SELECT DISTINCT sale_id AS id FROM invoices WHERE status = 'shipped' AND shipped_at <= ?1 LIMIT 500",
			)
			.bind(before - autocompleteAfter),
	]);
	return [...new Set(results.flatMap((r) => rowsOf<{ id: string }>(r).map((row) => row.id)))];
}
