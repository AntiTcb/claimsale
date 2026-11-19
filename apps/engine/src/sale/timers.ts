import { fromStored, MUTUAL_RESPONSE_WINDOW, pendingTimers, type Millis, type Timer } from "@claimsale/core";
import {
	rowsOf,
	toInvoice,
	toStoredRescind,
	type EntryRow,
	type InvoiceLineRow,
	type InvoiceRow,
	type ItemRow,
	type RescindRow,
} from "./rows.ts";
import type { SaleStorage } from "./storage.ts";
import { entriesQuery, itemsQuery, toLoadedItems } from "./store.ts";

/**
 * Mutual-agreement rescinds of a sale still waiting for the buyer's answer (§4.3.1).
 * Rows from before the `phase` column count when nothing answered, contested or resolved them.
 */
const AWAITING_MUTUAL = `r.reason_code = 'mutual_agreement' AND r.answered_at IS NULL
	AND (r.phase = 'awaiting_buyer' OR (r.phase IS NULL AND r.contested_at IS NULL AND r.resolved_at IS NULL))`;

/**
 * Every pending timer of one sale (STATE_MACHINES §7), from the sale's store in one round
 * trip (plus the sale row). The alarm handler runs the due ones and re-arms at the
 * earliest of the rest.
 */
export async function loadTimers(storage: SaleStorage, saleId: string, now: Millis): Promise<Timer[]> {
	await storage.ready(saleId);
	const record = await storage.loadSale(saleId, now, { fresh: true });
	if (!record) return [];
	const db = storage.local;
	const [items, entries, invoices, lines, rescinds] = await db.batch([
		itemsQuery(db, saleId, "all"),
		entriesQuery(db, saleId, "all"),
		db.prepare("SELECT * FROM invoices WHERE sale_id = ?1 AND status IN ('sent', 'shipped')").bind(saleId),
		db
			.prepare(
				"SELECT l.* FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.sale_id = ?1 AND i.status IN ('sent', 'shipped')",
			)
			.bind(saleId),
		db
			.prepare(
				`SELECT r.* FROM rescinds r JOIN entries e ON e.id = r.entry_id JOIN items i ON i.id = e.item_id
				WHERE i.sale_id = ?1 AND ${AWAITING_MUTUAL}`,
			)
			.bind(saleId),
	]);
	const loaded = toLoadedItems(rowsOf<ItemRow>(items), rowsOf<EntryRow>(entries));
	const lineRows = rowsOf<InvoiceLineRow>(lines);
	return pendingTimers(
		record.sale,
		[...loaded.values()].map((l) => l.item),
		rowsOf<InvoiceRow>(invoices).map((row) => toInvoice(row, lineRows, record.sellerTier)),
		rowsOf<RescindRow>(rescinds).flatMap((row) => {
			const rescind = fromStored(toStoredRescind(row));
			return rescind ? [{ id: row.id, rescind }] : [];
		}),
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
		db
			.prepare(
				`SELECT DISTINCT i.sale_id AS id FROM rescinds r JOIN entries e ON e.id = r.entry_id
				JOIN items i ON i.id = e.item_id WHERE ${AWAITING_MUTUAL} AND r.created_at <= ?1 LIMIT 500`,
			)
			.bind(before - MUTUAL_RESPONSE_WINDOW),
	]);
	return [...new Set(results.flatMap((r) => rowsOf<{ id: string }>(r).map((row) => row.id)))];
}
