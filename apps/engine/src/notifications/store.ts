/**
 * D1 access for notifications (WS-K). Raw D1 like the rest of the engine. ID lists are
 * passed as ONE JSON parameter (`json_each`), since D1 allows 100 bound parameters.
 * Email addresses are read here and never logged.
 */
import {
	parseEmailOff,
	parseNotificationPayload,
	type EmailStatus,
	type Listing,
	type NotificationPayload,
	type NotificationType,
	type Recipient,
	type SaleEventContext,
	type WantListEntry,
} from "@claimsale/core";
import { Data, Effect } from "effect";

export class NotifyDbError extends Data.TaggedError("NotifyDbError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {
	override get message() {
		return `notifications D1 ${this.operation} failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
	}
}

export const d1 = <A>(operation: string, run: () => Promise<A>) =>
	Effect.tryPromise({ try: run, catch: (cause) => new NotifyDbError({ operation, cause }) });

const ids = (values: Iterable<string | number>) => JSON.stringify([...values]);

/** Statements per D1 batch when writing many rows (one batch counts as one query). */
const BATCH = 50;

export type SaleContext = SaleEventContext & { readonly sellerName: string };

export const loadSaleContext = (
	db: D1Database,
	saleId: string,
	refs: { entryIds: string[]; itemIds: string[]; invoiceIds: string[] },
) =>
	d1("load sale context", async (): Promise<SaleContext | null> => {
		const [row, entries, items, invoices] = await Promise.all([
			db
				.prepare(
					`SELECT s.id, s.slug, s.title, s.seller_id, s.visibility, s.live_at, s.status, u.display_name
					FROM sales s JOIN users u ON u.id = s.seller_id WHERE s.id = ?1`,
				)
				.bind(saleId)
				.first<{
					id: string;
					slug: string;
					title: string;
					seller_id: string;
					visibility: string;
					live_at: number | null;
					status: string;
					display_name: string;
				}>(),
			db
				.prepare("SELECT id, user_id, kind FROM entries WHERE id IN (SELECT value FROM json_each(?1))")
				.bind(ids(refs.entryIds))
				.all<{ id: string; user_id: string; kind: "claim" | "offer" }>(),
			db
				// By primary key: a sale_id filter first would read every item of the sale.
				.prepare(
					"SELECT i.id, i.title FROM json_each(?2) j JOIN items i ON i.id = j.value WHERE i.sale_id = ?1",
				)
				.bind(saleId, ids(refs.itemIds))
				.all<{ id: string; title: string }>(),
			db
				.prepare(
					"SELECT i.id, i.buyer_id, i.total_cents FROM json_each(?2) j JOIN invoices i ON i.id = j.value WHERE i.sale_id = ?1",
				)
				.bind(saleId, ids(refs.invoiceIds))
				.all<{ id: string; buyer_id: string; total_cents: number }>(),
		]);
		if (!row) return null;
		return {
			sale: {
				id: row.id,
				slug: row.slug,
				title: row.title,
				sellerId: row.seller_id,
				visibility: row.visibility,
				liveAt: row.live_at,
				status: row.status,
			},
			sellerName: row.display_name,
			entries: new Map(entries.results.map((e) => [e.id, { buyerId: e.user_id, kind: e.kind }])),
			items: new Map(items.results.map((i) => [i.id, { title: i.title }])),
			invoices: new Map(
				invoices.results.map((i) => [i.id, { buyerId: i.buyer_id, totalCents: i.total_cents }]),
			),
		};
	});

export const followerIds = (db: D1Database, sellerId: string) =>
	d1("followers", async () => {
		const { results } = await db
			.prepare("SELECT follower_id FROM follows WHERE seller_id = ?1")
			.bind(sellerId)
			.all<{ follower_id: string }>();
		return results.map((r) => r.follower_id);
	});

/** A sale's catalogued, not withdrawn items (want-list candidates). */
export const saleListings = (db: D1Database, saleId: string) =>
	d1("sale listings", async (): Promise<Listing[]> => {
		const { results } = await db
			.prepare(
				`SELECT id, title, catalog_product_id, kind, finish, condition, language, price_cents FROM items
				WHERE sale_id = ?1 AND catalog_product_id IS NOT NULL AND withdrawn_at IS NULL`,
			)
			.bind(saleId)
			.all<{
				id: string;
				title: string;
				catalog_product_id: string;
				kind: string;
				finish: string | null;
				condition: string | null;
				language: string | null;
				price_cents: number;
			}>();
		return results.map((r) => ({
			itemId: r.id,
			title: r.title,
			catalogProductId: r.catalog_product_id,
			kind: r.kind,
			finish: r.finish,
			condition: r.condition,
			language: r.language,
			priceCents: r.price_cents,
		}));
	});

export const wantsForProducts = (db: D1Database, productIds: readonly number[]) =>
	d1("want lists", async (): Promise<WantListEntry[]> => {
		if (productIds.length === 0) return [];
		const { results } = await db
			.prepare(
				`SELECT id, user_id, product_id, finish, max_price_cents, min_condition, language FROM want_list_items
				WHERE product_id IN (SELECT value FROM json_each(?1))`,
			)
			.bind(ids(productIds))
			.all<{
				id: string;
				user_id: string;
				product_id: number;
				finish: string | null;
				max_price_cents: number | null;
				min_condition: string | null;
				language: string | null;
			}>();
		return results.map((r) => ({
			id: r.id,
			userId: r.user_id,
			productId: r.product_id,
			finish: r.finish,
			maxPriceCents: r.max_price_cents,
			minCondition: r.min_condition,
			language: r.language,
		}));
	});

/** Who can be emailed, and which categories they turned off. Users that don't exist are left out. */
export const recipients = (db: D1Database, userIds: readonly string[]) =>
	d1("recipients", async () => {
		const out = new Map<string, Recipient>();
		const unique = [...new Set(userIds)];
		for (let i = 0; i < unique.length; i += 500) {
			const { results } = await db
				.prepare(
					`SELECT u.id, u.email_verified, p.email_off FROM users u
					LEFT JOIN notification_preferences p ON p.user_id = u.id
					WHERE u.id IN (SELECT value FROM json_each(?1))`,
				)
				.bind(ids(unique.slice(i, i + 500)))
				.all<{ id: string; email_verified: number; email_off: string | null }>();
			for (const r of results)
				out.set(r.id, { emailVerified: r.email_verified === 1, emailOff: parseEmailOff(r.email_off) });
		}
		return out;
	});

export interface NewNotification {
	readonly id: string;
	readonly userId: string;
	readonly type: NotificationType;
	readonly payload: NotificationPayload;
	readonly dedupeKey: string;
	readonly emailStatus: EmailStatus;
	readonly emailDueAt: number | null;
	readonly createdAt: number;
}

/**
 * Inserts notifications, skipping any whose dedupe key exists (NOTIF-idempotent).
 * Returns the rows that were new.
 */
export const insertNotifications = (db: D1Database, rows: readonly NewNotification[]) =>
	d1("insert notifications", async () => {
		const inserted: Array<{ id: string; user_id: string; email_status: string }> = [];
		for (let i = 0; i < rows.length; i += BATCH) {
			const results = await db.batch<{ id: string; user_id: string; email_status: string }>(
				rows.slice(i, i + BATCH).map((r) =>
					db
						.prepare(
							`INSERT OR IGNORE INTO notifications
								(id, user_id, type, payload, read_at, created_at, dedupe_key, email_status, email_due_at, email_attempts)
							VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, 0)
							RETURNING id, user_id, email_status`,
						)
						.bind(
							r.id,
							r.userId,
							r.type,
							JSON.stringify(r.payload),
							r.createdAt,
							r.dedupeKey,
							r.emailStatus,
							r.emailDueAt,
						),
				),
			);
			for (const result of results) inserted.push(...result.results);
		}
		return inserted;
	});

/** Notifications with these dedupe keys whose email is due now (a retried batch finds them again). */
export const dueIdsByKeys = (db: D1Database, keys: readonly string[], now: number) =>
	d1("due notifications", async () => {
		const out: string[] = [];
		for (let i = 0; i < keys.length; i += 500) {
			const { results } = await db
				.prepare(
					`SELECT id FROM notifications WHERE dedupe_key IN (SELECT value FROM json_each(?1))
					AND email_status = 'pending' AND email_due_at <= ?2`,
				)
				.bind(ids(keys.slice(i, i + 500)), now)
				.all<{ id: string }>();
			out.push(...results.map((r) => r.id));
		}
		return out;
	});

/** Whether the user already had batched activity waiting (so a digest is already on its way). */
export const hasOtherBatched = (db: D1Database, userId: string, newIds: readonly string[]) =>
	d1("batched check", async () => {
		const row = await db
			.prepare(
				`SELECT 1 AS found FROM notifications WHERE user_id = ?1 AND email_status = 'batched'
				AND id NOT IN (SELECT value FROM json_each(?2)) LIMIT 1`,
			)
			.bind(userId, ids(newIds))
			.first<{ found: number }>();
		return row !== null;
	});

export interface ClaimedNotification {
	readonly id: string;
	readonly userId: string;
	readonly type: NotificationType;
	readonly payload: NotificationPayload;
	readonly readAt: number | null;
	readonly attempts: number;
}

interface ClaimedRow {
	id: string;
	user_id: string;
	type: NotificationType;
	payload: string | null;
	read_at: number | null;
	email_attempts: number;
}

const claimed = (rows: ClaimedRow[]): ClaimedNotification[] =>
	rows.map((r) => ({
		id: r.id,
		userId: r.user_id,
		type: r.type,
		payload: parsePayload(r.payload),
		readAt: r.read_at,
		attempts: r.email_attempts,
	}));

const parsePayload = parseNotificationPayload;

const CLAIM_COLUMNS = "RETURNING id, user_id, type, payload, read_at, email_attempts";

/**
 * Claims due pending emails before sending them (`pending → sent`), so the consumer and the
 * cron sweep never both send one. A failed send puts it back (markFailed).
 */
export const claimPending = (db: D1Database, notificationIds: readonly string[], now: number) =>
	d1("claim pending", async () => {
		if (notificationIds.length === 0) return [];
		const { results } = await db
			.prepare(
				`UPDATE notifications SET email_status = 'sent', emailed_at = ?2
				WHERE id IN (SELECT value FROM json_each(?1)) AND email_status = 'pending' AND email_due_at <= ?2
				${CLAIM_COLUMNS}`,
			)
			.bind(ids(notificationIds), now)
			.all<ClaimedRow>();
		return claimed(results);
	});

/** The cron's share: pending emails already due (lost queue messages, message delays). */
export const claimDuePending = (db: D1Database, now: number, limit: number) =>
	d1("claim due", async () => {
		const { results } = await db
			.prepare(
				`UPDATE notifications SET email_status = 'sent', emailed_at = ?1
				WHERE id IN (SELECT id FROM notifications WHERE email_status = 'pending' AND email_due_at <= ?1 LIMIT ?2)
				${CLAIM_COLUMNS}`,
			)
			.bind(now, limit)
			.all<ClaimedRow>();
		return claimed(results);
	});

/** Claims all of a user's batched activity for one digest. */
export const claimDigest = (db: D1Database, userId: string, now: number) =>
	d1("claim digest", async () => {
		const { results } = await db
			.prepare(
				`UPDATE notifications SET email_status = 'sent', emailed_at = ?2
				WHERE user_id = ?1 AND email_status = 'batched' ${CLAIM_COLUMNS}`,
			)
			.bind(userId, now)
			.all<ClaimedRow>();
		return claimed(results);
	});

/** Users whose digest is overdue (its queue message was lost or failed). */
export const dueDigestUsers = (db: D1Database, now: number, limit: number) =>
	d1("due digests", async () => {
		const { results } = await db
			.prepare(
				`SELECT DISTINCT user_id FROM notifications WHERE email_status = 'batched' AND email_due_at <= ?1 LIMIT ?2`,
			)
			.bind(now, limit)
			.all<{ user_id: string }>();
		return results.map((r) => r.user_id);
	});

export const markSkipped = (db: D1Database, notificationIds: readonly string[]) =>
	d1("mark skipped", async () => {
		if (notificationIds.length === 0) return;
		await db
			.prepare(
				"UPDATE notifications SET email_status = 'skipped', emailed_at = NULL WHERE id IN (SELECT value FROM json_each(?1))",
			)
			.bind(ids(notificationIds))
			.run();
	});

/** Gives up after this many failed sends. */
export const MAX_EMAIL_ATTEMPTS = 5;

/**
 * A send failed: back to `retryStatus` with a later due time, or `failed` for good after
 * MAX_EMAIL_ATTEMPTS.
 */
export const markFailed = (
	db: D1Database,
	notificationIds: readonly string[],
	retryStatus: "pending" | "batched",
	retryAt: number,
) =>
	d1("mark failed", async () => {
		if (notificationIds.length === 0) return;
		await db
			.prepare(
				`UPDATE notifications SET emailed_at = NULL, email_attempts = email_attempts + 1,
					email_status = CASE WHEN email_attempts + 1 >= ?2 THEN 'failed' ELSE ?3 END,
					email_due_at = ?4
				WHERE id IN (SELECT value FROM json_each(?1))`,
			)
			.bind(ids(notificationIds), MAX_EMAIL_ATTEMPTS, retryStatus, retryAt)
			.run();
	});

export const emailAddresses = (db: D1Database, userIds: readonly string[]) =>
	d1("email addresses", async () => {
		const { results } = await db
			.prepare("SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each(?1))")
			.bind(ids(new Set(userIds)))
			.all<{ id: string; email: string }>();
		return new Map(results.map((r) => [r.id, r.email]));
	});

// ---------------------------------------------------------------------------
// Messages

export interface PostedMessage {
	readonly messageId: string;
	readonly senderId: string;
	readonly senderName: string;
	readonly conversationId: string;
	readonly buyerId: string;
	readonly sellerId: string;
	readonly saleId: string;
	readonly saleSlug: string;
	readonly saleTitle: string;
}

export const loadPostedMessage = (db: D1Database, messageId: string) =>
	d1("posted message", async (): Promise<PostedMessage | null> => {
		const row = await db
			.prepare(
				`SELECT m.id, m.sender_id, u.display_name, c.id AS conversation_id, c.buyer_id, c.seller_id,
					s.id AS sale_id, s.slug, s.title
				FROM messages m
				JOIN conversations c ON c.id = m.conversation_id
				JOIN sales s ON s.id = c.sale_id
				JOIN users u ON u.id = m.sender_id
				WHERE m.id = ?1`,
			)
			.bind(messageId)
			.first<{
				id: string;
				sender_id: string;
				display_name: string;
				conversation_id: string;
				buyer_id: string;
				seller_id: string;
				sale_id: string;
				slug: string;
				title: string;
			}>();
		return row
			? {
					messageId: row.id,
					senderId: row.sender_id,
					senderName: row.display_name,
					conversationId: row.conversation_id,
					buyerId: row.buyer_id,
					sellerId: row.seller_id,
					saleId: row.sale_id,
					saleSlug: row.slug,
					saleTitle: row.title,
				}
			: null;
	});

// ---------------------------------------------------------------------------
// Allowlist invites

export interface InviteSale {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly sellerId: string;
	readonly sellerName: string;
	readonly status: string;
	readonly visibility: string;
	readonly liveAt: number | null;
	readonly allowlistEnabled: boolean;
}

export const loadInviteSale = (db: D1Database, saleId: string) =>
	d1("invite sale", async (): Promise<InviteSale | null> => {
		const row = await db
			.prepare(
				`SELECT s.id, s.slug, s.title, s.seller_id, u.display_name, s.status, s.visibility, s.live_at,
					COALESCE(a.allowlist_enabled, 0) AS allowlist_enabled
				FROM sales s JOIN users u ON u.id = s.seller_id LEFT JOIN sale_access a ON a.sale_id = s.id
				WHERE s.id = ?1`,
			)
			.bind(saleId)
			.first<{
				id: string;
				slug: string;
				title: string;
				seller_id: string;
				display_name: string;
				status: string;
				visibility: string;
				live_at: number | null;
				allowlist_enabled: number;
			}>();
		return row
			? {
					id: row.id,
					slug: row.slug,
					title: row.title,
					sellerId: row.seller_id,
					sellerName: row.display_name,
					status: row.status,
					visibility: row.visibility,
					liveAt: row.live_at,
					allowlistEnabled: row.allowlist_enabled === 1,
				}
			: null;
	});

/** Claims up to `limit` addresses not yet invited (marks them invited before sending). */
export const claimInvites = (db: D1Database, saleId: string, now: number, limit: number) =>
	d1("claim invites", async () => {
		const { results } = await db
			.prepare(
				`UPDATE sale_allowlist SET invited_at = ?2
				WHERE sale_id = ?1 AND email IN (
					SELECT email FROM sale_allowlist WHERE sale_id = ?1 AND invited_at IS NULL ORDER BY email LIMIT ?3
				) RETURNING email`,
			)
			.bind(saleId, now, limit)
			.all<{ email: string }>();
		return results.map((r) => r.email);
	});

export const unclaimInvite = (db: D1Database, saleId: string, email: string) =>
	d1("unclaim invite", async () => {
		await db
			.prepare("UPDATE sale_allowlist SET invited_at = NULL WHERE sale_id = ?1 AND email = ?2")
			.bind(saleId, email)
			.run();
	});
