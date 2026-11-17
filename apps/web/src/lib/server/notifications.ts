import {
	describeStoredNotification,
	NOTIFICATION_CATEGORIES,
	parseEmailOff,
	type Millis,
	type NotificationCategory,
} from "@claimsale/core";
import { and, desc, eq, isNull, sql, type Db } from "@claimsale/db";
import { notificationPreferences } from "@claimsale/db/messaging";
import { notifications } from "@claimsale/db/schema";

/**
 * The bell (PLAN §5 "Notifications", WS-K): the engine's queue consumer writes
 * `notifications`; the web Worker lists them, marks them read and stores email
 * preferences. In-app notifications are always on (NOTIF-preferences).
 */

export interface NotificationView {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly path: string;
	readonly read: boolean;
	readonly createdAt: Millis;
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
		.get();
	return row?.n ?? 0;
}

/** The newest notifications, with their copy (the same words as the email). */
export async function listNotifications(db: Db, userId: string, limit = 50): Promise<NotificationView[]> {
	const rows = await db
		.select({
			id: notifications.id,
			type: notifications.type,
			payload: notifications.payload,
			readAt: notifications.readAt,
			createdAt: notifications.createdAt,
		})
		.from(notifications)
		.where(eq(notifications.userId, userId))
		.orderBy(desc(notifications.createdAt), desc(notifications.id))
		.limit(limit)
		.all();
	return rows.map((row) => {
		const copy = describeStoredNotification(row.type, row.payload);
		return {
			id: row.id,
			title: copy.title,
			body: copy.body,
			path: copy.path,
			read: row.readAt !== null,
			createdAt: row.createdAt,
		};
	});
}

/** Marks one notification read and returns where it points (only the owner's). */
export async function openNotification(
	db: Db,
	userId: string,
	id: string,
	now: Millis,
): Promise<string | undefined> {
	const [row] = await db
		.update(notifications)
		.set({ readAt: sql`COALESCE(${notifications.readAt}, ${now})` })
		.where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
		.returning({ type: notifications.type, payload: notifications.payload })
		.all();
	if (!row) return undefined;
	return describeStoredNotification(row.type, row.payload).path;
}

export async function markAllRead(db: Db, userId: string, now: Millis): Promise<void> {
	await db
		.update(notifications)
		.set({ readAt: now })
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

/**
 * Opening a conversation reads its message notifications, so their emails aren't sent.
 *
 * @spec MSG-email-unread
 */
export async function markConversationNotificationsRead(
	db: Db,
	userId: string,
	conversationId: string,
	now: Millis,
): Promise<void> {
	await db
		.update(notifications)
		.set({ readAt: now })
		.where(
			and(
				eq(notifications.userId, userId),
				eq(notifications.type, "new_message"),
				isNull(notifications.readAt),
				sql`json_extract(${notifications.payload}, '$.conversationId') = ${conversationId}`,
			),
		);
}

/** The categories the user turned email off for. */
export async function readEmailOff(db: Db, userId: string): Promise<Set<NotificationCategory>> {
	const row = await db
		.select({ emailOff: notificationPreferences.emailOff })
		.from(notificationPreferences)
		.where(eq(notificationPreferences.userId, userId))
		.get();
	return parseEmailOff(row?.emailOff ?? []);
}

/**
 * Saves which categories get email; unknown names are ignored.
 *
 * @spec NOTIF-preferences
 */
export async function saveEmailPreferences(
	db: Db,
	userId: string,
	emailOn: Iterable<string>,
	now: Millis,
): Promise<Set<NotificationCategory>> {
	const on = new Set(emailOn);
	const off = NOTIFICATION_CATEGORIES.filter((c) => !on.has(c));
	await db
		.insert(notificationPreferences)
		.values({ userId, emailOff: off, updatedAt: now })
		.onConflictDoUpdate({ target: notificationPreferences.userId, set: { emailOff: off, updatedAt: now } });
	return new Set(off);
}
