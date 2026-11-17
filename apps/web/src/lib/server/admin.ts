import { type Millis } from "@claimsale/core";
import { and, asc, eq, isNull, sql, type Db } from "@claimsale/db";
import { accountFlags, imageHashes } from "@claimsale/db/photos";
import { itemImages, items, sales, users } from "@claimsale/db/schema";
import { error, redirect, type RequestEvent } from "@sveltejs/kit";
import type { SessionUser } from "./auth.ts";

/**
 * The in-app admin (TECH_STACK S19; D23: the owner is the sole admin). An account is an
 * admin when `users.role` is `admin`, which is set with SQL, never through a form:
 *
 *   wrangler d1 execute DB --env <env> --remote \
 *     --command "UPDATE users SET role = 'admin' WHERE handle = '<handle>'"
 */

export function isAdmin(user: Pick<SessionUser, "role"> | null | undefined): boolean {
	return user?.role === "admin";
}

/** Every /admin load and action: signed out → sign in; signed in but not an admin → 404. */
export function requireAdmin(event: Pick<RequestEvent, "locals" | "url">): SessionUser {
	const user = event.locals.user;
	if (!user) redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	// 404, not 403: the admin area's existence isn't advertised.
	if (!isAdmin(user)) error(404, "Not found");
	return user;
}

export interface HeldPhoto {
	readonly imageId: string;
	readonly saleId: string;
	readonly saleTitle: string;
	/** Null for a timestamp photo. */
	readonly itemTitle: string | null;
	readonly sellerHandle: string | null;
	readonly matchImageId: string | null;
	readonly matchDistance: number | null;
	readonly createdAt: Millis;
}

/**
 * Photos held for admin review (IMG-dup-review), oldest first. The matched image is
 * shown to the admin only; sellers never see it.
 */
export async function heldPhotos(db: Db, limit = 50): Promise<HeldPhoto[]> {
	return db
		.select({
			imageId: itemImages.id,
			saleId: sales.id,
			saleTitle: sales.title,
			itemTitle: items.title,
			sellerHandle: users.handle,
			matchImageId: itemImages.matchImageId,
			matchDistance: itemImages.matchDistance,
			createdAt: itemImages.createdAt,
		})
		.from(itemImages)
		.innerJoin(sales, eq(sales.id, itemImages.saleId))
		.innerJoin(users, eq(users.id, itemImages.sellerId))
		.leftJoin(items, eq(items.id, itemImages.itemId))
		.where(eq(itemImages.status, "review"))
		.orderBy(asc(itemImages.createdAt))
		.limit(limit)
		.all();
}

export interface FlaggedAccount {
	readonly flagId: string;
	readonly userId: string;
	readonly handle: string | null;
	readonly displayName: string;
	readonly count: number;
	/** Rejected-as-duplicate photos in total (IMG-repeat-offender). */
	readonly rejectedTotal: number;
	readonly createdAt: Millis;
}

/**
 * Open photo flags (IMG-repeat-offender), oldest first. Rescind abuse-guard flags are
 * on /admin/rescinds (`overturnedFlags` in moderation.ts).
 */
export async function openFlags(db: Db, limit = 50): Promise<FlaggedAccount[]> {
	return db
		.select({
			flagId: accountFlags.id,
			userId: accountFlags.userId,
			handle: users.handle,
			displayName: users.displayName,
			count: accountFlags.count,
			rejectedTotal: sql<number>`(SELECT count(*) FROM ${imageHashes} WHERE ${imageHashes.sellerId} = ${accountFlags.userId} AND ${imageHashes.decision} = 'rejected' AND ${imageHashes.reason} IN ('duplicate', 'possible_duplicate'))`,
			createdAt: accountFlags.createdAt,
		})
		.from(accountFlags)
		.innerJoin(users, eq(users.id, accountFlags.userId))
		.where(and(isNull(accountFlags.resolvedAt), eq(accountFlags.reason, "repeat_photo_rejections")))
		.orderBy(asc(accountFlags.createdAt))
		.limit(limit)
		.all();
}

/** Closes a flag after review; a later run of rejections can flag the account again. */
export async function resolveFlag(db: Db, flagId: string, adminId: string, now: Millis): Promise<boolean> {
	const rows = await db
		.update(accountFlags)
		.set({ resolvedAt: now, resolvedBy: adminId })
		.where(and(eq(accountFlags.id, flagId), isNull(accountFlags.resolvedAt)))
		.returning({ id: accountFlags.id })
		.all();
	return rows.length > 0;
}
