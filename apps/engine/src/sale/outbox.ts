import { localTable, type LocalTable } from "@claimsale/db/local";
import { sqlValue, withoutCapture } from "./local-db.ts";

/**
 * Copies a SaleEngine's committed writes to D1 (STATE_MACHINES §9, WS-N).
 *
 * The outbox holds, in commit order: rows the triggers recorded (table + primary key),
 * cross-sale statements a command asked for (`sql`), and the command's events. A flush
 * takes the oldest entries, writes each recorded row's *current* state to D1 (so a row
 * changed ten times in a rush is written once), runs the statements in order, and only
 * after D1 accepted the batch queues the events. Then it deletes what it sent. A failed
 * batch leaves everything in place for the next try; every write is idempotent.
 *
 * @spec SM-9-outbox
 */

/** Outbox entries read per round, and statements sent in one D1 batch. */
const READ_LIMIT = 400;
const STATEMENT_LIMIT = 100;

interface OutboxRow {
	readonly seq: number;
	readonly kind: "row" | "sql" | "events";
	readonly tbl: string | null;
	readonly pk: string | null;
	readonly payload: string | null;
}

export function pendingOutbox(sql: SqlStorage): number {
	return sql.exec<{ n: number }>("SELECT count(*) AS n FROM _outbox").one().n;
}

const q = (name: string) => `"${name}"`;

/** Columns D1 keeps for itself on an invoice: its number is per seller, across sales. */
const INVOICE_KEEPS = new Set(["id", "sale_id", "buyer_id", "seller_id", "created_at", "invoice_number"]);

function upsert(d1: D1Database, table: LocalTable, row: Record<string, unknown>): D1PreparedStatement {
	if (table.name === "items") {
		// The web Worker owns the item's other columns; versions only grow.
		return d1
			.prepare(
				`UPDATE items SET state = ?2, version = MAX(version, ?3), decision_deadline = ?4,
					offers_lapse_at = ?5, withdrawn_at = ?6, units_won = ?7, updated_at = ?8 WHERE id = ?1`,
			)
			.bind(
				...[
					row["id"],
					row["state"],
					row["version"],
					row["decision_deadline"],
					row["offers_lapse_at"],
					row["withdrawn_at"],
					row["units_won"],
					row["updated_at"],
				].map(sqlValue),
			);
	}
	const isInvoice = table.name === "invoices";
	const columns = table.columns.map((c) => c.name).filter((n) => !(isInvoice && n === "invoice_number"));
	const values = columns.map((_, i) => `?${i + 1}`);
	const params = columns.map((n) => sqlValue(row[n]));
	if (isInvoice) {
		// Numbered per seller in D1 when first written, as before WS-N.
		columns.push("invoice_number");
		values.push(
			`(SELECT COALESCE(MAX(invoice_number), 0) + 1 FROM invoices WHERE seller_id = ?${columns.indexOf("seller_id") + 1})`,
		);
	}
	const updates = table.columns
		.map((c) => c.name)
		.filter((n) => n !== table.primaryKey && !(isInvoice && INVOICE_KEEPS.has(n)))
		.map((n) => `${q(n)} = excluded.${q(n)}`);
	return d1
		.prepare(
			`INSERT INTO ${q(table.name)} (${columns.map(q).join(", ")}) VALUES (${values.join(", ")})
			ON CONFLICT (${q(table.primaryKey)}) DO ${updates.length > 0 ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`,
		)
		.bind(...params);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A command's events, as the outbox stored them. */
function parseEvents(payload: string | null): Array<Record<string, unknown>> {
	const value: unknown = JSON.parse(payload ?? "[]");
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** A cross-sale statement, as the outbox stored it. */
function parseStatement(payload: string | null): { sql: string; params: unknown[] } {
	const value: unknown = JSON.parse(payload ?? "{}");
	if (!isRecord(value) || typeof value["sql"] !== "string" || !Array.isArray(value["params"]))
		throw new Error("malformed outbox statement");
	return { sql: value["sql"], params: value["params"] };
}

const remove = (d1: D1Database, table: LocalTable, pk: string) =>
	d1.prepare(`DELETE FROM ${q(table.name)} WHERE ${q(table.primaryKey)} = ?1`).bind(pk);

/**
 * One round: up to STATEMENT_LIMIT statements to D1, then the events, then the outbox
 * entries they covered are deleted. Returns whether entries remain. Throws when D1 or
 * the queue refused (nothing is deleted then).
 */
export async function flushOutbox(deps: {
	readonly sql: SqlStorage;
	readonly storage: DurableObjectStorage;
	readonly d1: D1Database;
	readonly send: (events: ReadonlyArray<Record<string, unknown>>) => Promise<void>;
}): Promise<boolean> {
	const { sql, d1 } = deps;
	const entries = sql
		.exec<OutboxRow & Record<string, SqlStorageValue>>(
			"SELECT seq, kind, tbl, pk, payload FROM _outbox ORDER BY seq LIMIT ?1",
			READ_LIMIT,
		)
		.toArray();
	if (entries.length === 0) return false;
	const statements: D1PreparedStatement[] = [];
	const events: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	const auditIds: string[] = [];
	let last = 0;
	for (const entry of entries) {
		if (statements.length >= STATEMENT_LIMIT) break;
		last = entry.seq;
		if (entry.kind === "events") {
			events.push(...parseEvents(entry.payload));
		} else if (entry.kind === "sql") {
			const { sql: text, params } = parseStatement(entry.payload);
			statements.push(d1.prepare(text).bind(...params.map(sqlValue)));
		} else if (entry.tbl !== null && entry.pk !== null) {
			const key = `${entry.tbl}\u0000${entry.pk}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const table = localTable(entry.tbl);
			const row = sql
				.exec(`SELECT * FROM ${q(table.name)} WHERE ${q(table.primaryKey)} = ?1`, entry.pk)
				.toArray()[0];
			statements.push(row ? upsert(d1, table, row) : remove(d1, table, entry.pk));
			if (row && table.name === "audit_log") auditIds.push(entry.pk);
		}
	}
	if (statements.length > 0) await d1.batch(statements);
	if (events.length > 0) await deps.send(events);
	deps.storage.transactionSync(() => {
		sql.exec("DELETE FROM _outbox WHERE seq <= ?1", last);
		// Audit rows are D1's alone: once there, the local copy goes.
		if (auditIds.length > 0) {
			withoutCapture(sql, () => {
				for (const id of auditIds) sql.exec("DELETE FROM audit_log WHERE id = ?1", id);
			});
		}
	});
	return pendingOutbox(sql) > 0;
}
