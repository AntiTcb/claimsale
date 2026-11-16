import type { Db } from "@claimsale/db";
import { sql } from "@claimsale/db";
import { rateLimits } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";

/**
 * A fixed-window counter in D1 for limits Better Auth doesn't cover (phone codes).
 * It shares Better Auth's `rate_limits` table; our keys start with `cs:` so they
 * never collide with its `<ip><path>` keys. Here `last_request` is the start of
 * the current window. One upsert, so concurrent requests can't both slip under.
 */

export interface Limit {
	readonly windowMs: number;
	readonly max: number;
}

/** Counts one attempt against `key` and returns whether it is within the limit. */
export async function consume(db: Db, key: string, limit: Limit, now: number): Promise<boolean> {
	const expired = sql`${now} - ${rateLimits.lastRequest} >= ${limit.windowMs}`;
	const row = await db
		.insert(rateLimits)
		.values({ id: uuidv7(), key: `cs:${key}`, count: 1, lastRequest: now })
		.onConflictDoUpdate({
			target: rateLimits.key,
			set: {
				count: sql`CASE WHEN ${expired} THEN 1 ELSE ${rateLimits.count} + 1 END`,
				lastRequest: sql`CASE WHEN ${expired} THEN ${now} ELSE ${rateLimits.lastRequest} END`,
			},
		})
		.returning({ count: rateLimits.count })
		.get();
	return (row?.count ?? 1) <= limit.max;
}
