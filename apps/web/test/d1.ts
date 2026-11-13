import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * A D1Database stand-in for unit tests, backed by an in-memory `node:sqlite`
 * database with every migration in packages/db/migrations applied. It covers the
 * calls drizzle-orm/d1 and Better Auth make (prepare/bind/all/first/run/raw/batch).
 */

const MIGRATIONS = join(import.meta.dirname, "../../../packages/db/migrations");

function toInput(value: unknown): SQLInputValue {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	return value as SQLInputValue;
}

export function testD1(): D1Database {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	for (const file of readdirSync(MIGRATIONS)
		.filter((f) => f.endsWith(".sql"))
		.toSorted()) {
		for (const statement of readFileSync(join(MIGRATIONS, file), "utf8").split("--> statement-breakpoint")) {
			if (statement.trim()) sqlite.exec(statement);
		}
	}

	const statement = (sql: string, params: unknown[]) => {
		const args = () => params.map(toInput);
		const self = {
			bind: (...values: unknown[]) => statement(sql, values),
			all: async () => ({ results: sqlite.prepare(sql).all(...args()), success: true, meta: {} }),
			first: async (column?: string) => {
				const row = sqlite.prepare(sql).get(...args()) as Record<string, unknown> | undefined;
				if (row === undefined) return null;
				return column === undefined ? row : (row[column] ?? null);
			},
			run: async () => {
				const result = sqlite.prepare(sql).run(...args());
				return {
					success: true,
					results: [],
					meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
				};
			},
			raw: async () => {
				const prepared = sqlite.prepare(sql);
				prepared.setReturnArrays(true);
				return prepared.all(...args());
			},
		};
		return self;
	};

	return {
		prepare: (sql: string) => statement(sql, []),
		batch: async (statements: Array<{ all: () => Promise<unknown> }>) => {
			const results = [];
			// D1 runs a batch's statements in order, one after another.
			// oxlint-disable-next-line no-await-in-loop
			for (const s of statements) results.push(await s.all());
			return results;
		},
		exec: async (sql: string) => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
	} as unknown as D1Database;
}
