import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as catalog from "./catalog.ts";
import * as messaging from "./messaging.ts";
import * as photos from "./photos.ts";
import * as coreSchema from "./schema.ts";

const schema = { ...coreSchema, ...catalog, ...photos, ...messaging };

export { schema };
// Query helpers, re-exported so every package uses this package's drizzle-orm
// (a second copy, e.g. resolved with a different peer set, has incompatible types).
export { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
export type { SQL } from "drizzle-orm";

/**
 * `column IN (values…)` with a single bound parameter (the values as a JSON array), however
 * many values there are. D1 refuses a statement with more than 100 bound parameters, so a
 * list that grows with the data (item, invoice or user IDs) must use this, not `inArray`.
 * SQLite still uses the column's index for `IN (SELECT …)`.
 */
export function inList(column: SQLWrapper, values: readonly (string | number)[]): SQL {
	return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

/** `column NOT IN (values…)`, with one bound parameter like {@link inList}. */
export function notInList(column: SQLWrapper, values: readonly (string | number)[]): SQL {
	return sql`${column} NOT IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

export function createDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
