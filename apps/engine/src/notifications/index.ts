/**
 * Notifications (milestone 9, WS-K; PLAN §5 "Notifications"). The SaleEngine sends each
 * committed batch of events to the notifications queue; this consumer turns them into
 * `notifications` rows (the bell) and email, honouring each user's preferences, batching
 * a seller's activity into digests and announcing new sales to followers and want lists.
 * The cron sweep delivers anything a lost or delayed queue message left behind.
 *
 * Queue messages (all carry an optional `traceparent`, TECH_STACK §4):
 * - `sale_events`       a committed batch from a SaleEngine (WS-E)
 * - `notify_deliver`    send the due emails of these notifications (fan-out chunks, message nudges)
 * - `notify_digest`     send a seller's digest (sent with a delay of SELLER_DIGEST_WINDOW)
 * - `allowlist_invites` email a private sale's invite list (deferred from WS-A)
 */
import {
	describeNotification,
	emailPlan,
	followerNotifications,
	MESSAGE_EMAIL_DELAY,
	notificationsForSaleEvents,
	referencedIds,
	SELLER_DIGEST_WINDOW,
	sellerDigest,
	wantListNotifications,
	type NotificationDraft,
} from "@claimsale/core";
import { digestEmail, inviteEmail, notificationEmail } from "@claimsale/emails";
import { Clock, Effect, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { Mailer } from "../mailer.ts";
import {
	claimDigest,
	claimDuePending,
	claimInvites,
	claimPending,
	dueDigestUsers,
	dueIdsByKeys,
	emailAddresses,
	followerIds,
	hasOtherBatched,
	insertNotifications,
	loadInviteSale,
	loadPostedMessage,
	loadSaleContext,
	markFailed,
	markSkipped,
	recipients,
	saleListings,
	unclaimInvite,
	wantsForProducts,
	type ClaimedNotification,
	type NewNotification,
} from "./store.ts";

export { NotifyDbError } from "./store.ts";

export interface NotifyDeps {
	readonly db: D1Database;
	readonly queue: Pick<Queue, "send" | "sendBatch">;
	/** The web app's origin for links in email; empty gives site-relative links. */
	readonly siteUrl: string;
}

const traceparent = Schema.optional(Schema.String);

export const SaleEventsMessage = Schema.Struct({
	kind: Schema.Literal("sale_events"),
	sale_id: Schema.String,
	events: Schema.Array(Schema.Unknown),
	traceparent,
});
export type SaleEventsMessage = typeof SaleEventsMessage.Type;

export const NotifyDeliverMessage = Schema.Struct({
	kind: Schema.Literal("notify_deliver"),
	ids: Schema.Array(Schema.String),
	traceparent,
});

export const NotifyDigestMessage = Schema.Struct({
	kind: Schema.Literal("notify_digest"),
	user_id: Schema.String,
	traceparent,
});

export const AllowlistInvitesMessage = Schema.Struct({
	kind: Schema.Literal("allowlist_invites"),
	sale_id: Schema.String,
	traceparent,
});

export const NotificationQueueMessage = Schema.Union([
	SaleEventsMessage,
	NotifyDeliverMessage,
	NotifyDigestMessage,
	AllowlistInvitesMessage,
]);
export type NotificationQueueMessage = typeof NotificationQueueMessage.Type;

export const decodeNotificationMessage = Schema.decodeUnknownOption(NotificationQueueMessage);

/** Emails sent inline by one message; the rest go out as `notify_deliver` chunks of this size. */
export const DELIVER_CHUNK = 25;
/** Invites sent per `allowlist_invites` message; more are continued by a follow-up message. */
export const INVITE_CHUNK = 25;
const SWEEP_LIMIT = 100;
/** A failed send is tried again this much later (by the cron sweep). */
const RETRY_DELAY = 5 * 60_000;

const PREFERENCES_PATH = "/me/notifications";
const link = (deps: NotifyDeps, path: string) => `${deps.siteUrl}${path}`;

// ---------------------------------------------------------------------------
// Writing notifications

/**
 * Writes drafts as notifications with their email plan, then schedules what isn't sent
 * inline: a digest for sellers with new batched activity. Returns the IDs whose email is due now.
 *
 * @spec NOTIF-idempotent — rows are keyed by `dedupe_key`; a redelivered batch inserts nothing new,
 * but still finds (and sends) the due emails a failed attempt left behind.
 * @spec NOTIF-preferences
 * @spec NOTIF-seller-batch
 */
export const writeNotifications = (deps: NotifyDeps, drafts: readonly NotificationDraft[]) =>
	Effect.gen(function* () {
		if (drafts.length === 0) return [] as string[];
		const now = yield* Clock.currentTimeMillis;
		const people = yield* recipients(
			deps.db,
			drafts.map((d) => d.userId),
		);
		const rows: NewNotification[] = [];
		for (const draft of drafts) {
			const recipient = people.get(draft.userId);
			if (!recipient) continue;
			const plan = emailPlan(draft.type, recipient, now);
			rows.push({
				id: uuidv7(),
				userId: draft.userId,
				type: draft.type,
				payload: draft.payload,
				dedupeKey: draft.dedupeKey,
				emailStatus: plan.status,
				emailDueAt: plan.status === "pending" ? (plan.dueAt ?? now) : plan.dueAt,
				createdAt: now,
			});
		}
		const inserted = yield* insertNotifications(deps.db, rows);
		const batchedBy = new Map<string, string[]>();
		for (const row of inserted) {
			if (row.email_status !== "batched") continue;
			batchedBy.set(row.user_id, [...(batchedBy.get(row.user_id) ?? []), row.id]);
		}
		for (const [userId, newIds] of batchedBy) {
			// The first activity of a window schedules the digest; later activity joins it.
			if (yield* hasOtherBatched(deps.db, userId, newIds)) continue;
			yield* Effect.tryPromise(() =>
				deps.queue.send(
					{ kind: "notify_digest", user_id: userId },
					{ contentType: "json", delaySeconds: SELLER_DIGEST_WINDOW / 1000 },
				),
			);
		}
		yield* Effect.logInfo("notifications written").pipe(
			Effect.annotateLogs({ drafts: drafts.length, inserted: inserted.length, digests: batchedBy.size }),
		);
		return yield* dueIdsByKeys(
			deps.db,
			rows.map((r) => r.dedupeKey),
			now,
		);
	});

/** Sends the first chunk now and queues the rest, so a big fan-out spreads over several invocations. */
const deliverOrQueue = (deps: NotifyDeps, ids: readonly string[]) =>
	Effect.gen(function* () {
		const now = ids.slice(0, DELIVER_CHUNK);
		const later: string[][] = [];
		for (let i = DELIVER_CHUNK; i < ids.length; i += DELIVER_CHUNK)
			later.push(ids.slice(i, i + DELIVER_CHUNK));
		for (let i = 0; i < later.length; i += 100) {
			const chunk = later.slice(i, i + 100);
			yield* Effect.tryPromise(() =>
				deps.queue.sendBatch(
					chunk.map((part) => ({
						body: { kind: "notify_deliver", ids: part },
						contentType: "json" as const,
					})),
				),
			);
		}
		yield* deliver(deps, now);
	});

// ---------------------------------------------------------------------------
// Sending email

/** Sends the claimed notifications' emails; one that was read in the meantime isn't sent. */
const sendClaimed = (deps: NotifyDeps, rows: readonly ClaimedNotification[]) =>
	Effect.gen(function* () {
		if (rows.length === 0) return { sent: 0, failed: 0 };
		const mailer = yield* Mailer;
		const read = rows.filter((r) => r.readAt !== null).map((r) => r.id);
		yield* markSkipped(deps.db, read);
		const unread = rows.filter((r) => r.readAt === null);
		const addresses = yield* emailAddresses(
			deps.db,
			unread.map((r) => r.userId),
		);
		const now = yield* Clock.currentTimeMillis;
		let sent = 0;
		const failed: string[] = [];
		for (const row of unread) {
			const to = addresses.get(row.userId);
			if (!to) {
				failed.push(row.id);
				continue;
			}
			const copy = describeNotification(row.type, row.payload);
			const mail = notificationEmail({
				title: copy.title,
				body: copy.body,
				actionLabel: copy.action,
				url: link(deps, copy.path),
				preferencesUrl: link(deps, PREFERENCES_PATH),
			});
			const ok = yield* mailer.send({ to, ...mail }).pipe(
				Effect.as(true),
				Effect.catchTag("MailError", (error) =>
					Effect.logWarning("notification email failed; retried later", error.cause).pipe(
						Effect.annotateLogs({ notification_id: row.id, type: row.type }),
						Effect.as(false),
					),
				),
			);
			if (ok) sent++;
			else failed.push(row.id);
		}
		yield* markFailed(deps.db, failed, "pending", now + RETRY_DELAY);
		return { sent, failed: failed.length };
	});

/** Delivers the due emails among these notifications. */
export const deliver = (deps: NotifyDeps, ids: readonly string[]) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const rows = yield* claimPending(deps.db, ids, now);
		const result = yield* sendClaimed(deps, rows);
		if (rows.length > 0)
			yield* Effect.logInfo("notification emails delivered").pipe(Effect.annotateLogs(result));
		return result;
	});

/**
 * One email for all of a seller's batched activity.
 *
 * @spec NOTIF-seller-batch — "12 new claims in the last few minutes", not twelve emails.
 */
export const sendDigest = (deps: NotifyDeps, userId: string) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const rows = yield* claimDigest(deps.db, userId, now);
		if (rows.length === 0) return false;
		const unread = rows.filter((r) => r.readAt === null);
		if (unread.length === 0) {
			yield* markSkipped(
				deps.db,
				rows.map((r) => r.id),
			);
			return false;
		}
		const addresses = yield* emailAddresses(deps.db, [userId]);
		const to = addresses.get(userId);
		const digest = sellerDigest(unread);
		const mailer = yield* Mailer;
		const ok = to
			? yield* mailer
					.send({
						to,
						...digestEmail({
							subject: digest.subject,
							heading: "Activity on your sales",
							lines: digest.lines,
							actionLabel: "Open your sales",
							url: link(deps, digest.path),
							preferencesUrl: link(deps, PREFERENCES_PATH),
						}),
					})
					.pipe(
						Effect.as(true),
						Effect.catchTag("MailError", (error) =>
							Effect.logWarning("digest email failed; retried later", error.cause).pipe(Effect.as(false)),
						),
					)
			: false;
		if (!ok) {
			yield* markFailed(
				deps.db,
				rows.map((r) => r.id),
				"batched",
				now + RETRY_DELAY,
			);
			return false;
		}
		yield* markSkipped(
			deps.db,
			rows.filter((r) => r.readAt !== null).map((r) => r.id),
		);
		yield* Effect.logInfo("seller digest sent").pipe(Effect.annotateLogs({ notifications: unread.length }));
		return true;
	});

// ---------------------------------------------------------------------------
// Sale events

/**
 * One committed batch of a sale's events → notifications and email.
 *
 * @spec SM-2-go-live-alarm — publishing and going live tell the followers of a public sale.
 * @spec TCG-want-list-notify — a public sale's catalogued listings are matched against want lists.
 */
export const handleSaleEvents = (deps: NotifyDeps, messageId: string, body: SaleEventsMessage) =>
	Effect.gen(function* () {
		const context = yield* loadSaleContext(deps.db, body.sale_id, referencedIds(body.events));
		if (!context) {
			yield* Effect.logWarning("sale events for a missing sale dropped");
			return;
		}
		const { drafts, followUps } = notificationsForSaleEvents(body.events, context, `se:${messageId}`);
		const all = [...drafts];
		if (followUps.followers) {
			const followers = yield* followerIds(deps.db, context.sale.sellerId);
			all.push(
				...followerNotifications(
					{ ...context.sale, sellerName: context.sellerName },
					followers,
					followUps.followers,
				),
			);
		}
		if (followUps.matchWantLists) {
			const listings = yield* saleListings(deps.db, context.sale.id);
			const productIds = [
				...new Set(listings.map((l) => Number(l.catalogProductId)).filter((n) => Number.isSafeInteger(n))),
			];
			const wants = yield* wantsForProducts(deps.db, productIds);
			all.push(...wantListNotifications(context.sale, wants, listings));
		}
		const due = yield* writeNotifications(deps, all);
		yield* deliverOrQueue(deps, due);
		if (followUps.sendInvites) yield* requestInvites(deps.queue, context.sale.id);
	}).pipe(Effect.annotateLogs({ sale_id: body.sale_id, events: body.events.length }));

// ---------------------------------------------------------------------------
// Messages (the web Worker stores them; the engine notifies the recipient)

export const MessagePostedInput = Schema.Struct({
	messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type MessagePostedInput = typeof MessagePostedInput.Type;

/**
 * A new message: an in-app notification for the other side now, an email only if it is
 * still unread after MESSAGE_EMAIL_DELAY.
 *
 * @spec MSG-email-unread
 */
export const messagePosted = (deps: NotifyDeps, input: unknown) =>
	Effect.gen(function* () {
		const { messageId } = yield* Schema.decodeUnknownEffect(MessagePostedInput)(input);
		const message = yield* loadPostedMessage(deps.db, messageId);
		if (!message) return false;
		const recipient = message.senderId === message.buyerId ? message.sellerId : message.buyerId;
		yield* writeNotifications(deps, [
			{
				userId: recipient,
				type: "new_message",
				dedupeKey: `message:${messageId}`,
				payload: {
					saleId: message.saleId,
					saleSlug: message.saleSlug,
					saleTitle: message.saleTitle,
					conversationId: message.conversationId,
					senderName: message.senderName,
				},
			},
		]);
		const ids = yield* Effect.tryPromise(() =>
			deps.db
				.prepare("SELECT id FROM notifications WHERE dedupe_key = ?1 AND email_status = 'pending'")
				.bind(`message:${messageId}`)
				.all<{ id: string }>(),
		);
		if (ids.results.length > 0) {
			yield* Effect.tryPromise(() =>
				deps.queue.send(
					{ kind: "notify_deliver", ids: ids.results.map((r) => r.id) },
					{ contentType: "json", delaySeconds: MESSAGE_EMAIL_DELAY / 1000 },
				),
			);
		}
		return true;
	});

// ---------------------------------------------------------------------------
// Allowlist invites (D5; deferred from WS-A)

export const InviteRequestInput = Schema.Struct({
	saleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	sellerId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type InviteRequestInput = typeof InviteRequestInput.Type;

const requestInvites = (queue: NotifyDeps["queue"], saleId: string) =>
	Effect.tryPromise(() =>
		queue.send({ kind: "allowlist_invites", sale_id: saleId }, { contentType: "json" }),
	);

/** The seller saved the invite list of a published private sale: invite whoever is new. */
export const requestAllowlistInvites = (deps: NotifyDeps, input: unknown) =>
	Effect.gen(function* () {
		const { saleId, sellerId } = yield* Schema.decodeUnknownEffect(InviteRequestInput)(input);
		const sale = yield* loadInviteSale(deps.db, saleId);
		if (!sale || sale.sellerId !== sellerId) return false;
		yield* requestInvites(deps.queue, saleId);
		return true;
	});

const INVITABLE = new Set(["scheduled", "live"]);

/**
 * Emails every address on a published private sale's invite list that hasn't had an invite.
 *
 * @spec NOTIF-allowlist-invite — once per address: when the sale is published, or when the
 * address is added later; drafts invite nobody.
 */
export const sendInvites = (deps: NotifyDeps, saleId: string) =>
	Effect.gen(function* () {
		const sale = yield* loadInviteSale(deps.db, saleId);
		if (!sale || sale.visibility !== "private" || !sale.allowlistEnabled || !INVITABLE.has(sale.status)) {
			return { sent: 0, failed: 0 };
		}
		const now = yield* Clock.currentTimeMillis;
		const emails = yield* claimInvites(deps.db, saleId, now, INVITE_CHUNK);
		const mailer = yield* Mailer;
		let sent = 0;
		let failed = 0;
		for (const to of emails) {
			const mail = inviteEmail({
				saleTitle: sale.title,
				sellerName: sale.sellerName,
				when:
					sale.status === "scheduled" && sale.liveAt !== null ? new Date(sale.liveAt).toUTCString() : null,
				url: link(deps, `/s/${sale.slug}`),
			});
			const ok = yield* mailer.send({ to, ...mail }).pipe(
				Effect.as(true),
				Effect.catchTag("MailError", (error) =>
					Effect.logWarning("invite email failed; retried", error.cause).pipe(Effect.as(false)),
				),
			);
			if (ok) sent++;
			else {
				failed++;
				yield* unclaimInvite(deps.db, saleId, to);
			}
		}
		if (emails.length === INVITE_CHUNK && failed === 0) yield* requestInvites(deps.queue, saleId);
		yield* Effect.logInfo("sale invites sent").pipe(Effect.annotateLogs({ sale_id: saleId, sent, failed }));
		return { sent, failed };
	});

// ---------------------------------------------------------------------------
// Queue and cron entry points

function programFor(
	message: Message,
	body: NotificationQueueMessage,
	deps: NotifyDeps,
): Effect.Effect<unknown, unknown, Mailer> {
	switch (body.kind) {
		case "sale_events":
			return handleSaleEvents(deps, message.id, body);
		case "notify_deliver":
			return deliver(deps, body.ids);
		case "notify_digest":
			return sendDigest(deps, body.user_id);
		case "allowlist_invites":
			return sendInvites(deps, body.sale_id).pipe(
				Effect.flatMap((r) => (r.failed > 0 ? Effect.fail(new Error("some invites failed")) : Effect.void)),
			);
		default:
			return Effect.void;
	}
}

/** Handles one notifications-queue message; acks it, or retries it on a D1 or queue failure. */
export const handleNotificationMessage = (
	message: Message,
	body: NotificationQueueMessage,
	deps: NotifyDeps,
) => {
	return programFor(message, body, deps).pipe(
		Effect.andThen(Effect.sync(() => message.ack())),
		Effect.catchCause((cause) =>
			Effect.logWarning("notification message failed; will retry", cause).pipe(
				Effect.andThen(Effect.sync(() => message.retry())),
			),
		),
		Effect.annotateLogs({ queue_message_id: message.id, kind: body.kind }),
		Effect.withSpan(`engine.notifications.${body.kind}`, {
			attributes: { "queue.attempts": message.attempts },
		}),
	);
};

/** Cron backstop: due emails and overdue digests a lost or delayed queue message left behind. */
export const sweepNotifications = (deps: NotifyDeps) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const due = yield* claimDuePending(deps.db, now, SWEEP_LIMIT);
		const emails = yield* sendClaimed(deps, due);
		const users = yield* dueDigestUsers(deps.db, now, SWEEP_LIMIT);
		let digests = 0;
		for (const userId of users) if (yield* sendDigest(deps, userId)) digests++;
		yield* Effect.logInfo("notification sweep").pipe(Effect.annotateLogs({ ...emails, digests }));
		return { ...emails, digests };
	});
