import { drizzle } from "drizzle-orm/d1";
import * as catalog from "./catalog.ts";
import * as coreSchema from "./schema.ts";

const schema = { ...coreSchema, ...catalog };

export { schema };
// Query helpers, re-exported so every package uses this package's drizzle-orm
// (a second copy, e.g. resolved with a different peer set, has incompatible types).
export { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

export function createDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
