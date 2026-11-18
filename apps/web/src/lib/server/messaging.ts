import {
	canSend,
	hasPaymentHandle,
	MESSAGE_MAX_ATTACHMENTS,
	ok,
	participantOf,
	reject,
	REPORT_MAX_LENGTH,
	REPORT_REASONS,
	validateMessage,
	type Millis,
	type Participant,
	type Rejection,
	type Result,
} from "@claimsale/core";
import { and, asc, desc, eq, gt, inArray, or, sql, type Db } from "@claimsale/db";
import { conversations, messageAttachments, messages } from "@claimsale/db/messaging";
import { blocks, sales, users } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";
import { sanitizeImage, type SanitizeError } from "./image-sanitize.ts";
import type { ImageStore } from "./images.ts";
import { fileReport } from "./moderation.ts";

/**
 * Buyer↔seller messaging (PLAN §3 "Messaging", D18; WS-K): one conversation per buyer per
 * sale, image attachments in R2 (the IMAGES bucket, under `messages/`) served only to the
 * two parties, a payment-handle warning, reports and seller blocks. Message bodies are
 * user content and are never logged (CLAUDE.md non-negotiable 5).
 */

export type ConversationRow = typeof conversations.$inferSelect;

export type MessagingRejection = Rejection<
	| "not_found"
	| "not_participant"
	| "blocked"
	| "own_sale"
	| "empty"
	| "too_long"
	| "too_many_attachments"
	| "invalid_reason"
	| "already_reported"
	| "rate_limited"
	| SanitizeError
>;

const notFound = () => reject("not_found", "No such conversation");

// ---------------------------------------------------------------------------
// Conversations

/**
 * The buyer's conversation about a sale, created on first use.
 *
 * @spec MSG-one-conversation — unique per (sale, buyer); the seller can't open one on their own sale.
 */
export async function openConversation(
	db: Db,
	sale: { id: string; sellerId: string },
	buyerId: string,
	now: Millis,
): Promise<Result<ConversationRow, MessagingRejection>> {
	if (sale.sellerId === buyerId) return reject("own_sale", "This is your own sale");
	await db
		.insert(conversations)
		.values({ id: uuidv7(), saleId: sale.id, buyerId, sellerId: sale.sellerId, createdAt: now })
		.onConflictDoNothing();
	const row = await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.saleId, sale.id), eq(conversations.buyerId, buyerId)))
		.get();
	return row ? ok(row) : notFound();
}

export async function findBuyerConversation(
	db: Db,
	saleId: string,
	buyerId: string,
): Promise<ConversationRow | undefined> {
	return db
		.select()
		.from(conversations)
		.where(and(eq(conversations.saleId, saleId), eq(conversations.buyerId, buyerId)))
		.get();
}

export interface InboxEntry {
	readonly id: string;
	readonly saleTitle: string;
	readonly saleSlug: string;
	readonly side: Participant;
	readonly otherName: string;
	readonly otherHandle: string | null;
	readonly lastMessageAt: Millis | null;
	readonly unread: boolean;
}

/** The user's conversations, as buyer or seller, newest first. */
export async function inbox(db: Db, userId: string): Promise<InboxEntry[]> {
	const rows = await db
		.select({
			id: conversations.id,
			buyerId: conversations.buyerId,
			sellerId: conversations.sellerId,
			lastMessageAt: conversations.lastMessageAt,
			buyerReadAt: conversations.buyerReadAt,
			sellerReadAt: conversations.sellerReadAt,
			saleTitle: sales.title,
			saleSlug: sales.slug,
			lastSenderId: sql<string | null>`(SELECT ${messages.senderId} FROM ${messages}
				WHERE ${messages.conversationId} = ${conversations.id}
				ORDER BY ${messages.createdAt} DESC, ${messages.id} DESC LIMIT 1)`,
		})
		.from(conversations)
		.innerJoin(sales, eq(sales.id, conversations.saleId))
		.where(
			and(
				or(eq(conversations.buyerId, userId), eq(conversations.sellerId, userId)),
				sql`${conversations.lastMessageAt} IS NOT NULL`,
			),
		)
		.orderBy(desc(conversations.lastMessageAt))
		.limit(100)
		.all();
	const others = await namesOf(
		db,
		rows.map((r) => (r.buyerId === userId ? r.sellerId : r.buyerId)),
	);
	return rows.map((r) => {
		const side: Participant = r.buyerId === userId ? "buyer" : "seller";
		const readAt = side === "buyer" ? r.buyerReadAt : r.sellerReadAt;
		const other = others.get(side === "buyer" ? r.sellerId : r.buyerId);
		return {
			id: r.id,
			saleTitle: r.saleTitle,
			saleSlug: r.saleSlug,
			side,
			otherName: other?.displayName ?? "Someone",
			otherHandle: other?.handle ?? null,
			lastMessageAt: r.lastMessageAt,
			unread:
				r.lastSenderId !== null &&
				r.lastSenderId !== userId &&
				(readAt === null || (r.lastMessageAt ?? 0) > readAt),
		};
	});
}

async function namesOf(db: Db, ids: readonly string[]) {
	if (ids.length === 0) return new Map<string, { displayName: string; handle: string | null }>();
	const rows = await db
		.select({ id: users.id, displayName: users.displayName, handle: users.handle })
		.from(users)
		.where(inArray(users.id, [...new Set(ids)]))
		.all();
	return new Map(rows.map((r) => [r.id, { displayName: r.displayName, handle: r.handle }]));
}

export interface MessageView {
	readonly id: string;
	readonly mine: boolean;
	readonly senderName: string;
	readonly body: string;
	readonly paymentWarning: boolean;
	readonly createdAt: Millis;
	readonly attachments: ReadonlyArray<{
		id: string;
		url: string;
		width: number | null;
		height: number | null;
	}>;
}

export interface ConversationView {
	readonly id: string;
	readonly side: Participant;
	readonly sale: { id: string; slug: string; title: string; sellerId: string };
	readonly buyer: { id: string; displayName: string; handle: string | null };
	readonly seller: { id: string; displayName: string; handle: string | null };
	/** The seller blocked the buyer (MSG-block). */
	readonly blocked: boolean;
	readonly messages: readonly MessageView[];
}

/**
 * A conversation for one of its two parties; anyone else gets nothing (a 404 upstream).
 *
 * @spec MSG-one-conversation — only the buyer and the seller can read it.
 */
export async function loadConversation(
	db: Db,
	conversationId: string,
	viewerId: string,
): Promise<ConversationView | undefined> {
	const row = await db
		.select({
			conversation: conversations,
			saleSlug: sales.slug,
			saleTitle: sales.title,
		})
		.from(conversations)
		.innerJoin(sales, eq(sales.id, conversations.saleId))
		.where(eq(conversations.id, conversationId))
		.get();
	if (!row) return undefined;
	const side = participantOf(row.conversation, viewerId);
	if (side === null) return undefined;
	const names = await namesOf(db, [row.conversation.buyerId, row.conversation.sellerId]);
	const person = (id: string) => ({
		id,
		displayName: names.get(id)?.displayName ?? "Someone",
		handle: names.get(id)?.handle ?? null,
	});
	return {
		id: row.conversation.id,
		side,
		sale: {
			id: row.conversation.saleId,
			slug: row.saleSlug,
			title: row.saleTitle,
			sellerId: row.conversation.sellerId,
		},
		buyer: person(row.conversation.buyerId),
		seller: person(row.conversation.sellerId),
		blocked: await isBlocked(db, row.conversation.sellerId, row.conversation.buyerId),
		messages: await messagesOf(db, row.conversation, viewerId, 0),
	};
}

/** Messages after `after` (ms), oldest first, with attachment URLs. */
export async function messagesOf(
	db: Db,
	conversation: Pick<ConversationRow, "id" | "buyerId" | "sellerId">,
	viewerId: string,
	after: Millis,
): Promise<MessageView[]> {
	const rows = await db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversation.id), gt(messages.createdAt, after)))
		.orderBy(asc(messages.createdAt), asc(messages.id))
		.limit(500)
		.all();
	const attachments =
		rows.length === 0
			? []
			: await db
					.select()
					.from(messageAttachments)
					.where(
						inArray(
							messageAttachments.messageId,
							rows.map((r) => r.id),
						),
					)
					.orderBy(asc(messageAttachments.id))
					.all();
	const names = await namesOf(db, [conversation.buyerId, conversation.sellerId]);
	return rows.map((r) => ({
		id: r.id,
		mine: r.senderId === viewerId,
		senderName: names.get(r.senderId)?.displayName ?? "Someone",
		body: r.body,
		paymentWarning: r.paymentWarning,
		createdAt: r.createdAt,
		attachments: attachments
			.filter((a) => a.messageId === r.id)
			.map((a) => ({ id: a.id, url: `/api/messages/attachments/${a.id}`, width: a.width, height: a.height })),
	}));
}

/** The viewer has seen the conversation up to now. */
export async function markRead(db: Db, conversation: ConversationView, now: Millis): Promise<void> {
	await db
		.update(conversations)
		.set(conversation.side === "buyer" ? { buyerReadAt: now } : { sellerReadAt: now })
		.where(eq(conversations.id, conversation.id));
}

// ---------------------------------------------------------------------------
// Posting

export interface NewMessage {
	readonly body: string;
	readonly images: readonly Uint8Array[];
}

/**
 * Stores a message and its photos. The engine then notifies the other side (messagePosted).
 *
 * @spec MSG-payment-warning — flagged when stored, shown to both sides.
 * @spec MSG-block — a blocked buyer can't post.
 */
export async function postMessage(
	db: Db,
	store: ImageStore,
	conversation: Pick<ConversationRow, "id" | "buyerId" | "sellerId">,
	senderId: string,
	input: NewMessage,
	now: Millis,
): Promise<Result<{ messageId: string; paymentWarning: boolean }, MessagingRejection>> {
	const allowed = canSend(
		conversation,
		senderId,
		await isBlocked(db, conversation.sellerId, conversation.buyerId),
	);
	if (!allowed.ok) return allowed;
	const valid = validateMessage(input.body, input.images.length);
	if (!valid.ok) return valid;
	const cleaned = [];
	for (const image of input.images) {
		const clean = sanitizeImage(image);
		if (!clean.ok) return reject(clean.error, "Attach JPEG or WebP photos up to 5 MB");
		cleaned.push(clean.value);
	}
	const messageId = uuidv7();
	const paymentWarning = hasPaymentHandle(valid.value.body);
	const stored: Array<typeof messageAttachments.$inferInsert> = [];
	for (const clean of cleaned) {
		const id = uuidv7();
		const ext = clean.type === "image/webp" ? "webp" : "jpg";
		const r2Key = `messages/${conversation.id}/${id}.${ext}`;
		await store.put(r2Key, clean.bytes, { httpMetadata: { contentType: clean.type } });
		stored.push({
			id,
			messageId,
			conversationId: conversation.id,
			r2Key,
			contentType: clean.type,
			bytes: clean.bytes.byteLength,
			width: clean.width,
			height: clean.height,
			createdAt: now,
		});
	}
	const side = participantOf(conversation, senderId);
	try {
		await db.batch([
			db.insert(messages).values({
				id: messageId,
				conversationId: conversation.id,
				senderId,
				body: valid.value.body,
				paymentWarning,
				createdAt: now,
			}),
			...stored.map((a) => db.insert(messageAttachments).values(a)),
			db
				.update(conversations)
				.set({ lastMessageAt: now, ...(side === "buyer" ? { buyerReadAt: now } : { sellerReadAt: now }) })
				.where(eq(conversations.id, conversation.id)),
		]);
	} catch (error) {
		await store.delete(stored.map((a) => a.r2Key));
		throw error;
	}
	return ok({ messageId, paymentWarning });
}

/** Reads the composer's form: the text and the picked photos (an empty file input sends nothing). */
export async function readMessageForm(data: FormData): Promise<NewMessage> {
	const body = data.get("body");
	const images: Uint8Array[] = [];
	for (const value of data.getAll("photos")) {
		if (typeof value === "string" || value.size === 0) continue;
		// More than the limit is rejected by validateMessage; don't read them all into memory.
		if (images.length > MESSAGE_MAX_ATTACHMENTS) break;
		images.push(new Uint8Array(await value.arrayBuffer()));
	}
	return { body: typeof body === "string" ? body : "", images };
}

// ---------------------------------------------------------------------------
// Attachments

/**
 * A message photo and who may see it.
 *
 * @spec MSG-attachment-access — only the conversation's buyer and seller (and admins).
 */
export async function findAttachmentFor(
	db: Db,
	attachmentId: string,
	viewer: { id: string; admin: boolean } | null,
): Promise<{ r2Key: string; contentType: string } | undefined> {
	if (!viewer) return undefined;
	const row = await db
		.select({
			r2Key: messageAttachments.r2Key,
			contentType: messageAttachments.contentType,
			buyerId: conversations.buyerId,
			sellerId: conversations.sellerId,
		})
		.from(messageAttachments)
		.innerJoin(conversations, eq(conversations.id, messageAttachments.conversationId))
		.where(eq(messageAttachments.id, attachmentId))
		.get();
	if (!row) return undefined;
	if (!viewer.admin && participantOf(row, viewer.id) === null) return undefined;
	return { r2Key: row.r2Key, contentType: row.contentType };
}

// ---------------------------------------------------------------------------
// Blocks and reports

export async function isBlocked(db: Db, sellerId: string, userId: string): Promise<boolean> {
	const row = await db
		.select({ sellerId: blocks.sellerId })
		.from(blocks)
		.where(and(eq(blocks.sellerId, sellerId), eq(blocks.blockedUserId, userId)))
		.get();
	return row !== undefined;
}

/**
 * The seller blocks the buyer of one of their conversations.
 *
 * @spec MSG-block — the buyer can't message them or claim in their sales (SM-4.1-buyer-requirements).
 */
export async function blockBuyer(
	db: Db,
	conversation: ConversationView,
	sellerId: string,
	now: Millis,
): Promise<Result<true, MessagingRejection>> {
	if (conversation.side !== "seller" || conversation.seller.id !== sellerId)
		return reject("not_participant", "Only the seller can block");
	await db
		.insert(blocks)
		.values({ sellerId, blockedUserId: conversation.buyer.id, reason: "messages", createdAt: now })
		.onConflictDoNothing();
	return ok(true);
}

export async function unblockBuyer(
	db: Db,
	conversation: ConversationView,
	sellerId: string,
): Promise<Result<true, MessagingRejection>> {
	if (conversation.side !== "seller" || conversation.seller.id !== sellerId)
		return reject("not_participant", "Only the seller can unblock");
	await db
		.delete(blocks)
		.where(and(eq(blocks.sellerId, sellerId), eq(blocks.blockedUserId, conversation.buyer.id)));
	return ok(true);
}

/**
 * A participant reports a message to the admin queue. It goes through the shared report path
 * (`fileReport`, ADMIN-report-queue), so the admin sees it on /admin/reports with the rest.
 *
 * @spec MSG-report — one open report per message per reporter; you can't report your own message.
 */
export async function reportMessage(
	db: Db,
	conversation: ConversationView,
	reporterId: string,
	input: { messageId: string; reason: string; details: string },
	now: Millis,
): Promise<Result<true, MessagingRejection>> {
	const message = conversation.messages.find((m) => m.id === input.messageId);
	if (!message || message.mine) return reject("not_found", "No such message");
	if (!(REPORT_REASONS as readonly string[]).includes(input.reason))
		return reject("invalid_reason", "Pick a reason");
	const details = input.details.trim().slice(0, REPORT_MAX_LENGTH);
	const filed = await fileReport(
		db,
		reporterId,
		{ targetKind: "message", targetId: input.messageId, reason: input.reason, details },
		now,
	);
	if (filed.ok) return ok(true);
	switch (filed.error.code) {
		case "already_reported":
			return reject("already_reported", "You already reported this message");
		case "rate_limited":
			return reject("rate_limited", filed.error.message);
		default:
			return reject("not_found", "No such message");
	}
}
