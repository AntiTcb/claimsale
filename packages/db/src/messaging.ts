import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sales, users } from "./schema.ts";

/**
 * Notifications and messaging (milestone 9, WS-K; PLAN §3 "Messaging", §5 "Notifications").
 * In its own file, like the catalog and photos, so merges with the core tables stay simple.
 * The `notifications`, `follows` and `blocks` tables are in schema.ts (milestone 4).
 */

const millis = (name: string) => integer(name, { mode: "number" });

/** Per-user email preferences. A missing row means every category is on. */
export const notificationPreferences = sqliteTable("notification_preferences", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	/** JSON array of the categories (core NOTIFICATION_CATEGORIES) with email turned off. */
	emailOff: text("email_off", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.default(sql`'[]'`),
	updatedAt: millis("updated_at").notNull(),
});

/** One conversation per buyer per sale (D18, MSG-one-conversation). */
export const conversations = sqliteTable(
	"conversations",
	{
		id: text("id").primaryKey(),
		saleId: text("sale_id")
			.notNull()
			.references(() => sales.id, { onDelete: "cascade" }),
		buyerId: text("buyer_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		lastMessageAt: millis("last_message_at"),
		/** When each side last read the conversation (unread = a newer message from the other side). */
		buyerReadAt: millis("buyer_read_at"),
		sellerReadAt: millis("seller_read_at"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [
		uniqueIndex("conversations_sale_buyer").on(t.saleId, t.buyerId),
		index("conversations_buyer").on(t.buyerId, t.lastMessageAt),
		index("conversations_seller").on(t.sellerId, t.lastMessageAt),
	],
);

/** Message bodies are user content: never logged (CLAUDE.md non-negotiable 5). */
export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		senderId: text("sender_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		body: text("body").notNull(),
		/** MSG-payment-warning: the body looked like an off-platform payment request. */
		paymentWarning: integer("payment_warning", { mode: "boolean" }).notNull().default(false),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [index("messages_conversation").on(t.conversationId, t.createdAt)],
);

/** Message photos in R2 (the IMAGES bucket, keys under `messages/`), served only to the two parties. */
export const messageAttachments = sqliteTable(
	"message_attachments",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		r2Key: text("r2_key").notNull().unique(),
		contentType: text("content_type").notNull(),
		bytes: integer("bytes").notNull(),
		width: integer("width"),
		height: integer("height"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [index("message_attachments_message").on(t.messageId)],
);
