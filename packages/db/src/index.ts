import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export { schema };
// Query helpers, re-exported so every package uses this package's drizzle-orm
// (a second copy, e.g. resolved with a different peer set, has incompatible types).
export { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

export function createDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
