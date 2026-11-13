import type { AgeAttestation } from "@claimsale/core";
import type { Db } from "@claimsale/db";
import { users } from "@claimsale/db/schema";
import { and, eq, ne } from "@claimsale/db";

/** Profile reads and writes outside Better Auth (handles, age, public profile). */

export interface PublicProfile {
	readonly handle: string;
	readonly displayName: string;
	readonly avatarUrl: string | null;
	readonly fbProfileUrl: string | null;
	readonly memberSince: Date;
}

export async function findPublicProfile(db: Db, handle: string): Promise<PublicProfile | undefined> {
	const row = await db
		.select({
			handle: users.handle,
			displayName: users.displayName,
			avatarUrl: users.image,
			fbProfileUrl: users.fbProfileUrl,
			memberSince: users.createdAt,
		})
		.from(users)
		.where(eq(users.handle, handle.toLowerCase()))
		.get();
	return row?.handle ? { ...row, handle: row.handle } : undefined;
}

/** Whether a handle is free (for `exceptUserId`, their own current handle counts as free). */
export async function isHandleAvailable(db: Db, handle: string, exceptUserId?: string): Promise<boolean> {
	const row = await db
		.select({ id: users.id })
		.from(users)
		.where(
			exceptUserId ? and(eq(users.handle, handle), ne(users.id, exceptUserId)) : eq(users.handle, handle),
		)
		.get();
	return row === undefined;
}

/** Sets the fields every account needs before using the site (sign-up form or onboarding). */
export async function completeIdentity(
	db: Db,
	userId: string,
	fields: { handle: string; displayName: string; ageAttested: AgeAttestation },
	now: Date,
): Promise<void> {
	await db
		.update(users)
		.set({ ...fields, ageAttestedAt: now, updatedAt: now })
		.where(eq(users.id, userId));
}

export async function updateProfile(
	db: Db,
	userId: string,
	fields: { handle: string; displayName: string; fbProfileUrl: string | null },
	now: Date,
): Promise<void> {
	await db
		.update(users)
		.set({ ...fields, updatedAt: now })
		.where(eq(users.id, userId));
}

/** SQLite's unique-constraint error, e.g. two people taking the same handle at once. */
export function isUniqueViolation(error: unknown): boolean {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
	const message = error instanceof Error ? `${error.message} ${cause}` : String(error);
	return /UNIQUE constraint failed/i.test(message);
}
