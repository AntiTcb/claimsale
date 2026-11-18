import { ok, reject, type Millis, type Rejection, type Result } from "@claimsale/core";
import { and, eq, sql, type Db } from "@claimsale/db";
import { follows, users } from "@claimsale/db/schema";

/**
 * Follow a seller (D41): followers are told when the seller schedules or opens a public
 * sale (the engine's consumer, `SM-2-go-live-alarm` followers part).
 */

/** The user behind a public handle (server-side only; IDs aren't sent to the page). */
export async function userIdByHandle(db: Db, handle: string): Promise<string | undefined> {
	const row = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.handle, handle.toLowerCase()))
		.get();
	return row?.id;
}

export async function isFollowing(db: Db, followerId: string, sellerId: string): Promise<boolean> {
	const row = await db
		.select({ sellerId: follows.sellerId })
		.from(follows)
		.where(and(eq(follows.followerId, followerId), eq(follows.sellerId, sellerId)))
		.get();
	return row !== undefined;
}

export async function followerCount(db: Db, sellerId: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(follows)
		.where(eq(follows.sellerId, sellerId))
		.get();
	return row?.n ?? 0;
}

export async function follow(
	db: Db,
	followerId: string,
	sellerId: string,
	now: Millis,
): Promise<Result<true, Rejection<"self">>> {
	if (followerId === sellerId) return reject("self", "You can't follow yourself");
	await db.insert(follows).values({ followerId, sellerId, createdAt: now }).onConflictDoNothing();
	return ok(true);
}

export async function unfollow(db: Db, followerId: string, sellerId: string): Promise<void> {
	await db.delete(follows).where(and(eq(follows.followerId, followerId), eq(follows.sellerId, sellerId)));
}
