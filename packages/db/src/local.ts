import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { auditLog, entries, invoiceLines, invoices, items, rescinds, takebackRequests } from "./schema.ts";

/**
 * The tables a SaleEngine keeps in its own SQLite (STATE_MACHINES §9, WS-N): one sale's
 * items, entries, invoices and what hangs off them. Their columns come from this schema,
 * so a migration that adds a column here reaches every engine without a second copy.
 */

export interface LocalColumn {
	readonly name: string;
	readonly type: string;
	readonly notNull: boolean;
	/** A SQL literal, or null when the column has no plain default. */
	readonly defaultSql: string | null;
}

export interface LocalTable {
	readonly name: string;
	readonly primaryKey: string;
	readonly columns: readonly LocalColumn[];
}

const literal = (value: unknown): string | null => {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
	// JSON object defaults are stored as text.
	if (value !== null && typeof value === "object" && !("queryChunks" in value))
		return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
	return null;
};

function column(c: SQLiteColumn): LocalColumn {
	const defaultSql = c.hasDefault ? literal(c.default) : null;
	return {
		name: c.name,
		type: c.getSQLType(),
		// A NOT NULL column whose default is computed by SQL stays nullable locally.
		notNull: c.notNull && (!c.hasDefault || defaultSql !== null),
		defaultSql,
	};
}

function spec(table: SQLiteTable): LocalTable {
	const config = getTableConfig(table);
	const pk = config.columns.filter((c) => c.primary);
	if (pk.length !== 1) throw new Error(`${config.name} needs a single-column primary key`);
	return { name: config.name, primaryKey: pk[0]!.name, columns: config.columns.map(column) };
}

/** In foreign-key order: a table only refers to tables before it. */
export const LOCAL_TABLES: readonly LocalTable[] = [
	items,
	entries,
	invoices,
	invoiceLines,
	rescinds,
	takebackRequests,
	auditLog,
].map(spec);

export const localTable = (name: string): LocalTable => {
	const table = LOCAL_TABLES.find((t) => t.name === name);
	if (!table) throw new Error(`${name} is not a local table`);
	return table;
};
