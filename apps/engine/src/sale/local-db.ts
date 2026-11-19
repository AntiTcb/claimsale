import { LOCAL_TABLES, type LocalTable } from "@claimsale/db/local";

/**
 * A SaleEngine's own SQLite (STATE_MACHINES §9, WS-N): one sale's items, entries,
 * invoices, rescinds, take-backs and fresh audit rows, with the same columns as D1, so
 * the write path's SQL runs unchanged on either.
 *
 * Every write to these tables is recorded in `_outbox` by triggers (while capture is on),
 * and `outbox.ts` copies the rows to D1. Hydration and refreshes from D1 turn capture off,
 * so copying D1's own rows back in doesn't send them out again.
 *
 * @spec SM-9-local-store
 */

const q = (name: string) => `"${name}"`;

/** The bookkeeping tables next to the sale's own. */
export const LOCAL_META_TABLES = ["_outbox", "_engine_meta", "_engine_flags"] as const;

/** Indexes the write path's queries need (D1 has more, for other readers). */
const LOCAL_INDEXES = [
	`CREATE INDEX IF NOT EXISTS items_sale_sort ON items (sale_id, sort_order, id)`,
	`CREATE INDEX IF NOT EXISTS entries_item ON entries (item_id, created_at, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS entries_one_pending ON entries (item_id, user_id) WHERE status IN ('open', 'countered')`,
	`CREATE INDEX IF NOT EXISTS invoices_sale ON invoices (sale_id, created_at, id)`,
	`CREATE INDEX IF NOT EXISTS invoice_lines_invoice ON invoice_lines (invoice_id)`,
	`CREATE INDEX IF NOT EXISTS invoice_lines_entry ON invoice_lines (entry_id)`,
	`CREATE INDEX IF NOT EXISTS rescinds_entry ON rescinds (entry_id)`,
	`CREATE INDEX IF NOT EXISTS takeback_requests_entry ON takeback_requests (entry_id, status)`,
];

function columnSql(c: LocalTable["columns"][number], primaryKey: string): string {
	const parts = [q(c.name), c.type];
	if (c.name === primaryKey) parts.push("PRIMARY KEY");
	if (c.notNull) parts.push("NOT NULL");
	if (c.defaultSql !== null) parts.push(`DEFAULT ${c.defaultSql}`);
	return parts.join(" ");
}

/** Items only ever change locally (the web Worker creates and deletes them in D1). */
const capturedOps = (table: LocalTable) =>
	table.name === "items" ? (["UPDATE"] as const) : (["INSERT", "UPDATE", "DELETE"] as const);

/**
 * Creates the local tables, adds columns a migration added to D1 since, and (re)creates
 * the capture triggers. Idempotent; runs when the object starts.
 */
export function ensureLocalSchema(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS _engine_meta (k TEXT PRIMARY KEY, v TEXT)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS _engine_flags (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
	sql.exec(`INSERT OR IGNORE INTO _engine_flags (k, v) VALUES ('capture', 1)`);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS _outbox (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			tbl TEXT,
			pk TEXT,
			payload TEXT
		)`,
	);
	for (const table of LOCAL_TABLES) {
		sql.exec(
			`CREATE TABLE IF NOT EXISTS ${q(table.name)} (${table.columns.map((c) => columnSql(c, table.primaryKey)).join(", ")})`,
		);
		const have = new Set(
			sql
				.exec<{ name: string }>(`PRAGMA table_info(${q(table.name)})`)
				.toArray()
				.map((c) => c.name),
		);
		for (const c of table.columns) {
			if (have.has(c.name)) continue;
			// Expand only (CLAUDE.md 6): a new column is nullable unless it has a default.
			const def = c.defaultSql === null ? "" : ` NOT NULL DEFAULT ${c.defaultSql}`;
			sql.exec(`ALTER TABLE ${q(table.name)} ADD COLUMN ${q(c.name)} ${c.type}${def}`);
		}
		for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
			const name = q(`_capture_${table.name}_${op.toLowerCase()}`);
			sql.exec(`DROP TRIGGER IF EXISTS ${name}`);
			if (!(capturedOps(table) as readonly string[]).includes(op)) continue;
			const row = op === "DELETE" ? "OLD" : "NEW";
			sql.exec(
				`CREATE TRIGGER ${name} AFTER ${op} ON ${q(table.name)}
				WHEN (SELECT v FROM _engine_flags WHERE k = 'capture') = 1
				BEGIN
					INSERT INTO _outbox (kind, tbl, pk) VALUES ('row', '${table.name}', ${row}.${q(table.primaryKey)});
				END`,
			);
		}
	}
	for (const index of LOCAL_INDEXES) sql.exec(index);
}

/** Runs `fn` with the capture triggers off (rows copied in from D1). Call inside a transaction. */
export function withoutCapture<T>(sql: SqlStorage, fn: () => T): T {
	sql.exec(`UPDATE _engine_flags SET v = 0 WHERE k = 'capture'`);
	try {
		return fn();
	} finally {
		sql.exec(`UPDATE _engine_flags SET v = 1 WHERE k = 'capture'`);
	}
}

export function readMeta(sql: SqlStorage, key: string): string | null {
	const row = sql.exec<{ v: string | null }>(`SELECT v FROM _engine_meta WHERE k = ?1`, key).toArray()[0];
	return row?.v ?? null;
}

export function writeMeta(sql: SqlStorage, key: string, value: string | null): void {
	if (value === null) sql.exec(`DELETE FROM _engine_meta WHERE k = ?1`, key);
	else
		sql.exec(
			`INSERT INTO _engine_meta (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
			key,
			value,
		);
}

/** Inserts (or replaces) D1 rows into a local table, as they are. Capture must be off. */
export function copyRows(sql: SqlStorage, table: LocalTable, rows: readonly Record<string, unknown>[]): void {
	if (rows.length === 0) return;
	const names = table.columns.map((c) => c.name);
	const statement = `INSERT OR REPLACE INTO ${q(table.name)} (${names.map(q).join(", ")}) VALUES (${names.map((_, i) => `?${i + 1}`).join(", ")})`;
	for (const row of rows) sql.exec(statement, ...names.map((n) => sqlValue(row[n])));
}

/** Drops every local row (and the outbox). Capture must be off. */
export function clearLocal(sql: SqlStorage): void {
	for (const table of LOCAL_TABLES.toReversed()) sql.exec(`DELETE FROM ${q(table.name)}`);
	sql.exec(`DELETE FROM _outbox`);
	sql.exec(`DELETE FROM _engine_meta`);
}

type Bindable = string | number | null | ArrayBuffer;

/** D1 binds booleans as 1/0 and undefined as null; SQLite storage takes neither. */
export function sqlValue(value: unknown): Bindable {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number" || typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return value;
	if (typeof value === "bigint") return Number(value);
	return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// The D1 API over the object's SQLite, for the write path's existing queries.

class LocalStatement {
	constructor(
		readonly owner: LocalD1,
		readonly query: string,
		readonly params: readonly unknown[] = [],
	) {}

	bind(...params: unknown[]): LocalStatement {
		return new LocalStatement(this.owner, this.query, params);
	}

	/** Runs now (inside the caller's transaction, if any). */
	rows(): Record<string, unknown>[] {
		return this.owner.sql.exec(this.query, ...this.params.map(sqlValue)).toArray();
	}

	result(): D1Result {
		const cursor = this.owner.sql.exec(this.query, ...this.params.map(sqlValue));
		const results = cursor.toArray();
		return {
			results,
			success: true,
			meta: {
				duration: 0,
				size_after: 0,
				rows_read: cursor.rowsRead,
				rows_written: cursor.rowsWritten,
				last_row_id: 0,
				changed_db: cursor.rowsWritten > 0,
				changes: cursor.rowsWritten,
			},
			// The D1 type's meta has fields SQLite storage doesn't report; nothing here reads them.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		} as unknown as D1Result;
	}

	async first<T>(column?: string): Promise<T | null> {
		const row = this.rows()[0];
		if (row === undefined) return null;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		return (column === undefined ? row : row[column]) as T;
	}

	async all<T>(): Promise<D1Result<T>> {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		return this.result() as D1Result<T>;
	}

	async run(): Promise<D1Result> {
		return this.result();
	}

	async raw<T = unknown[]>(): Promise<T[]> {
		const cursor = this.owner.sql.exec(this.query, ...this.params.map(sqlValue));
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		return [...cursor.raw()] as T[];
	}
}

/**
 * `prepare` / `bind` / `first` / `all` / `run` / `batch` over the object's SQLite. A batch
 * is one synchronous transaction: it commits whole or not at all, like a D1 batch.
 */
export class LocalD1 {
	constructor(
		readonly sql: SqlStorage,
		readonly storage: DurableObjectStorage,
	) {}

	prepare(query: string): LocalStatement {
		return new LocalStatement(this, query);
	}

	async batch(statements: readonly unknown[]): Promise<D1Result[]> {
		const local = statements.map((s) => {
			if (!(s instanceof LocalStatement)) throw new Error("a local batch takes local statements only");
			return s;
		});
		return this.storage.transactionSync(() => local.map((s) => s.result()));
	}

	/** This object as the D1Database the write path's helpers take. */
	asD1(): D1Database {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		return this as unknown as D1Database;
	}
}
