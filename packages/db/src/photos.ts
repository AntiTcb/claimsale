import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./schema.ts";

/**
 * Photo authenticity (PLAN §3 "Photo authenticity", D63, TECH_STACK S33; WS-F2). In its
 * own file, like the catalog, so merges with the core tables stay simple.
 */

const millis = (name: string) => integer(name, { mode: "number" });

export const PHOTO_DECISIONS = ["approved", "review", "rejected"] as const;
export const PHOTO_REASONS = ["duplicate", "possible_duplicate", "own_reuse", "timestamp_reuse"] as const;

/**
 * The perceptual hashes of every verified photo, and the multi-index-hashing band index.
 *
 * - Each 64-bit hash is hex TEXT (D1 returns INTEGER as a JS number, which loses bits);
 *   the 16-bit bands are INTEGER.
 * - Only the `orig` variant is stored; an upload is looked up with all 5 of its variants.
 * - Rows outlive the photo, item and sale (no foreign keys to them), so another seller's
 *   image is matched "past or present". Only `approved` rows are matched.
 */
export const imageHashes = sqliteTable(
	"image_hashes",
	{
		/** The item_images row that was hashed. */
		imageId: text("image_id").primaryKey(),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id),
		saleId: text("sale_id").notNull(),
		/** Null for a sale's timestamp photo (D66). */
		itemId: text("item_id"),
		dhash: text("dhash").notNull(),
		phash: text("phash").notNull(),
		/** dHash bands, most significant first. */
		d0: integer("d0").notNull(),
		d1: integer("d1").notNull(),
		d2: integer("d2").notNull(),
		d3: integer("d3").notNull(),
		/** pHash bands, most significant first. */
		p0: integer("p0").notNull(),
		p1: integer("p1").notNull(),
		p2: integer("p2").notNull(),
		p3: integer("p3").notNull(),
		/** Mirrors item_images.status once decided; admin review moves `review` on. */
		decision: text("decision", { enum: PHOTO_DECISIONS }).notNull(),
		/** Why it was rejected or held (admins only; never shown to buyers or other sellers). */
		reason: text("reason", { enum: PHOTO_REASONS }),
		createdAt: millis("created_at").notNull(),
		decidedAt: millis("decided_at").notNull(),
		/** `system` (the verify job) or the admin's user ID. */
		decidedBy: text("decided_by").notNull(),
	},
	(t) => [
		index("image_hashes_d0").on(t.d0),
		index("image_hashes_d1").on(t.d1),
		index("image_hashes_d2").on(t.d2),
		index("image_hashes_d3").on(t.d3),
		index("image_hashes_p0").on(t.p0),
		index("image_hashes_p1").on(t.p1),
		index("image_hashes_p2").on(t.p2),
		index("image_hashes_p3").on(t.p3),
		index("image_hashes_seller_decision").on(t.sellerId, t.decision),
	],
);

/** `overturned_rescinds`: the rescind abuse guard (SM-4.3.1-abuse-guard, WS-I). */
export const ACCOUNT_FLAG_REASONS = ["repeat_photo_rejections", "overturned_rescinds"] as const;

/**
 * Accounts flagged for admin review (IMG-repeat-offender, SM-4.3.1-abuse-guard). At most
 * one open flag per reason.
 */
export const accountFlags = sqliteTable(
	"account_flags",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		reason: text("reason", { enum: ACCOUNT_FLAG_REASONS }).notNull(),
		/** The count that tripped the flag. */
		count: integer("count").notNull(),
		createdAt: millis("created_at").notNull(),
		resolvedAt: millis("resolved_at"),
		resolvedBy: text("resolved_by"),
	},
	(t) => [
		uniqueIndex("account_flags_open")
			.on(t.userId, t.reason)
			.where(sql`${t.resolvedAt} IS NULL`),
		index("account_flags_created").on(t.resolvedAt, t.createdAt),
	],
);
