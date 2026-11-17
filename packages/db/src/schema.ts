import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Milestone 0 only: a key/value table the health check reads to prove the D1
 * binding and migrations work end to end. Domain tables arrive with their
 * milestones (PLAN §6).
 */
export const appMeta = sqliteTable("app_meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

// ---------------------------------------------------------------------------
// Auth and identity (milestone 3, PLAN §5 "Auth and identity", §6).
// Better Auth owns users / sessions / auth_accounts / verifications / rate_limits;
// apps/web/src/lib/server/auth.ts maps its models onto these tables. Timestamps are
// integer milliseconds.

const ms = (name: string) => integer(name, { mode: "timestamp_ms" });

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
	/** Better Auth's `name`. Not unique (PLAN §5); shown with the avatar and handle. */
	displayName: text("display_name").notNull(),
	image: text("avatar_url"),
	/** Lowercase, unique; null until onboarding finishes (e.g. after a Discord sign-up). */
	handle: text("handle").unique(),
	/** D38: '13+' (with a parent's or guardian's permission under 18) or '18+'. */
	ageAttested: text("age_attested", { enum: ["13+", "18+"] }),
	ageAttestedAt: ms("age_attested_at"),
	fbProfileUrl: text("fb_profile_url"),
	country: text("country"),
	/** E.164, unique per account, never shown publicly (D55). Verified in a later slice. */
	phoneE164: text("phone_e164").unique(),
	phoneVerifiedAt: ms("phone_verified_at"),
	/** `admin` opens /admin (D23: the owner). Set with SQL, never through a form. */
	role: text("role", { enum: ["user", "admin"] })
		.notNull()
		.default("user"),
	createdAt: ms("created_at").notNull(),
	updatedAt: ms("updated_at").notNull(),
});

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: ms("expires_at").notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		createdAt: ms("created_at").notNull(),
		updatedAt: ms("updated_at").notNull(),
	},
	(t) => [index("sessions_user_id").on(t.userId)],
);

/** Sign-in methods per user (password, Discord). Named to avoid confusion with seller accounts. */
export const authAccounts = sqliteTable(
	"auth_accounts",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: ms("access_token_expires_at"),
		refreshTokenExpiresAt: ms("refresh_token_expires_at"),
		scope: text("scope"),
		password: text("password"),
		createdAt: ms("created_at").notNull(),
		updatedAt: ms("updated_at").notNull(),
	},
	(t) => [index("auth_accounts_user_id").on(t.userId)],
);

/** Email verification, magic link and password reset tokens. */
export const verifications = sqliteTable(
	"verifications",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: ms("expires_at").notNull(),
		createdAt: ms("created_at").notNull(),
		updatedAt: ms("updated_at").notNull(),
	},
	(t) => [index("verifications_identifier").on(t.identifier)],
);

/** Better Auth's rate limiter (Workers isolates share no memory). */
export const rateLimits = sqliteTable("rate_limits", {
	id: text("id").primaryKey(),
	key: text("key").notNull().unique(),
	count: integer("count").notNull(),
	lastRequest: integer("last_request").notNull(),
});

/**
 * The CapturingMailer's outbox (TECH_STACK §10): local, test and preview
 * environments write email here instead of sending it, so E2E tests can follow
 * links. Never written in staging or production.
 */
export const emailOutbox = sqliteTable(
	"email_outbox",
	{
		id: text("id").primaryKey(),
		to: text("to_address").notNull(),
		subject: text("subject").notNull(),
		text: text("text").notNull(),
		html: text("html"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("email_outbox_to").on(t.to, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Sales, items, entries and invoices (milestone 4, PLAN §6, STATE_MACHINES §2–§6).
// One expand-only migration for the whole core model, so later workstreams never
// race on these tables. Money is integer cents; timestamps are server-set integer
// milliseconds (plain numbers, matching `Millis` in packages/core). IDs are UUIDv7.
// Catalog tables (games, catalog_products, …) and image_hashes come in their own
// migrations, so `game_id` and `catalog_product_id` are plain text for now.

const millis = (name: string) => integer(name, { mode: "number" });
const cents = (name: string) => integer(name, { mode: "number" });
const flag = (name: string) => integer(name, { mode: "boolean" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

/** A seller's defaults (payment handles, terms, shipping), copied into each new sale. */
export const sellerProfiles = sqliteTable("seller_profiles", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	/** e.g. [{ "kind": "paypal", "value": "@ash" }]; shown on invoices only. */
	paymentHandles: json<Array<{ kind: string; value: string }>>("payment_handles"),
	defaultTerms: text("default_terms"),
	defaultShipping: json<unknown>("default_shipping"),
	/** The highlighted "% of market" button (D64). */
	defaultMarketPct: integer("default_market_pct"),
	createdAt: millis("created_at").notNull(),
	updatedAt: millis("updated_at").notNull(),
});

export const SALE_STATUSES = ["draft", "scheduled", "live", "closed", "archived", "deleted"] as const;
export const SALE_VISIBILITIES = ["public", "unlisted", "private"] as const;

export const sales = sqliteTable(
	"sales",
	{
		id: text("id").primaryKey(),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id),
		/** URL slug for /s/[slug]; unique and never reused. */
		slug: text("slug").notNull().unique(),
		title: text("title").notNull(),
		descriptionMd: text("description_md").notNull().default(""),
		coverImageId: text("cover_image_id"),
		/** D66: the sale's timestamp photo (an item_images row with item_id null). */
		timestampImageId: text("timestamp_image_id"),
		visibility: text("visibility", { enum: SALE_VISIBILITIES }).notNull().default("unlisted"),
		status: text("status", { enum: SALE_STATUSES }).notNull().default("draft"),
		/** D7: USD only at launch, stored so expanding doesn't need a migration. */
		currency: text("currency").notNull().default("USD"),
		liveAt: millis("live_at"),
		closesAt: millis("closes_at"),
		publishedAt: millis("published_at"),
		/** Release, offer and limit settings (SaleRules in apps/web). */
		rules: json<Record<string, unknown>>("rules").notNull().default({}),
		/** The shipping menu (D15). */
		shipping: json<unknown>("shipping"),
		/** Payment methods, payment deadline and other structured terms. */
		terms: json<Record<string, unknown>>("terms").notNull().default({}),
		/** Free-text rules and shipping policy. */
		termsMd: text("terms_md").notNull().default(""),
		createdAt: millis("created_at").notNull(),
		updatedAt: millis("updated_at").notNull(),
	},
	(t) => [
		index("sales_seller_status").on(t.sellerId, t.status),
		index("sales_browse").on(t.status, t.visibility, t.liveAt),
	],
);

/** Private sales (D5, D31): a password hash and/or an email allowlist. */
export const saleAccess = sqliteTable("sale_access", {
	saleId: text("sale_id")
		.primaryKey()
		.references(() => sales.id, { onDelete: "cascade" }),
	passwordHash: text("password_hash"),
	allowlistEnabled: flag("allowlist_enabled").notNull().default(false),
	updatedAt: millis("updated_at").notNull(),
});

export const saleAllowlist = sqliteTable(
	"sale_allowlist",
	{
		saleId: text("sale_id")
			.notNull()
			.references(() => sales.id, { onDelete: "cascade" }),
		/** Lowercased. Never logged (CLAUDE.md non-negotiable 5). */
		email: text("email").notNull(),
		invitedAt: millis("invited_at"),
		acceptedUserId: text("accepted_user_id").references(() => users.id),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.saleId, t.email] })],
);

export const ITEM_KINDS = ["single", "graded", "sealed", "accessory", "lot"] as const;
export const ITEM_STATES = ["available", "deciding", "sold_out", "withdrawn", "unsold"] as const;
export const OFFER_MODES = ["off", "on", "on_min"] as const;

export const items = sqliteTable(
	"items",
	{
		id: text("id").primaryKey(),
		saleId: text("sale_id")
			.notNull()
			.references(() => sales.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull(),
		/** A games.slug once the catalog lands (WS-C); no FK until then. */
		gameId: text("game_id").notNull(),
		kind: text("kind", { enum: ITEM_KINDS }).notNull().default("single"),
		/** A catalog_products.id (WS-C); no FK until then. */
		catalogProductId: text("catalog_product_id"),
		title: text("title").notNull(),
		descriptionMd: text("description_md").notNull().default(""),
		condition: text("condition"),
		finish: text("finish"),
		language: text("language"),
		/** Game- and kind-specific attributes, validated by the core schemas (TCG-attribute-schema). */
		attributes: json<Record<string, unknown>>("attributes").notNull().default({}),
		grader: text("grader"),
		grade: text("grade"),
		certNumber: text("cert_number"),
		/** Seller's own reference; unique per sale when set (import upserts match on it). */
		sku: text("sku"),
		priceCents: cents("price_cents").notNull(),
		quantity: integer("quantity").notNull().default(1),
		/** D12: most units one buyer can hold. */
		perBuyerLimit: integer("per_buyer_limit").notNull().default(1),
		offersMode: text("offers_mode", { enum: OFFER_MODES }).notNull().default("off"),
		/** Hidden minimum (Pro, D27); never sent to buyers. */
		minOfferCents: cents("min_offer_cents"),
		shippingOverrideCents: cents("shipping_override_cents"),
		/** Cached derived state (STATE_MACHINES §3), written by the engine. */
		state: text("state", { enum: ITEM_STATES }).notNull().default("available"),
		withdrawnAt: millis("withdrawn_at"),
		decisionDeadline: millis("decision_deadline"),
		offersLapseAt: millis("offers_lapse_at"),
		unitsWon: integer("units_won").notNull().default(0),
		/** Optimistic concurrency for the engine's batch writes (STATE_MACHINES §9). */
		version: integer("version").notNull().default(0),
		createdAt: millis("created_at").notNull(),
		updatedAt: millis("updated_at").notNull(),
	},
	(t) => [
		index("items_sale_sort").on(t.saleId, t.sortOrder),
		uniqueIndex("items_sale_sku")
			.on(t.saleId, t.sku)
			.where(sql`${t.sku} IS NOT NULL`),
		index("items_catalog_product").on(t.catalogProductId),
		index("items_game").on(t.gameId, t.kind),
		// The engine's cron sweep looks for due timers (STATE_MACHINES §7).
		index("items_decision_deadline")
			.on(t.decisionDeadline)
			.where(sql`${t.decisionDeadline} IS NOT NULL`),
		index("items_offers_lapse_at")
			.on(t.offersLapseAt)
			.where(sql`${t.offersLapseAt} IS NOT NULL`),
	],
);

/** Filterable attributes only (browse by game, PLAN §3); the full set is items.attributes. */
export const itemAttributes = sqliteTable(
	"item_attributes",
	{
		itemId: text("item_id")
			.notNull()
			.references(() => items.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		valueText: text("value_text"),
		valueNum: integer("value_num"),
	},
	(t) => [
		primaryKey({ columns: [t.itemId, t.key] }),
		index("item_attributes_text").on(t.key, t.valueText),
		index("item_attributes_num").on(t.key, t.valueNum),
	],
);

export const IMAGE_STATUSES = ["pending", "approved", "review", "rejected"] as const;

/**
 * Seller photos in R2. Every upload starts `pending`; the verify job (photo
 * authenticity, D63) moves it on. A timestamp photo (D66) has `item_id` null.
 */
export const itemImages = sqliteTable(
	"item_images",
	{
		id: text("id").primaryKey(),
		saleId: text("sale_id")
			.notNull()
			.references(() => sales.id, { onDelete: "cascade" }),
		itemId: text("item_id").references(() => items.id, { onDelete: "cascade" }),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id),
		r2Key: text("r2_key").notNull().unique(),
		contentType: text("content_type").notNull(),
		bytes: integer("bytes").notNull(),
		width: integer("width"),
		height: integer("height"),
		sortOrder: integer("sort_order").notNull().default(0),
		status: text("status", { enum: IMAGE_STATUSES }).notNull().default("pending"),
		matchImageId: text("match_image_id"),
		matchDistance: integer("match_distance"),
		verifiedAt: millis("verified_at"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [
		index("item_images_item_sort").on(t.itemId, t.sortOrder),
		index("item_images_sale").on(t.saleId),
		index("item_images_seller_status").on(t.sellerId, t.status),
		// The engine cron's sweep for photos left `pending` (WS-F2).
		index("item_images_status_created").on(t.status, t.createdAt),
	],
);

export const ENTRY_KINDS = ["claim", "offer"] as const;
export const ENTRY_STATUSES = [
	"open",
	"countered",
	"won",
	"declined",
	"withdrawn",
	"lost",
	"ended",
	"rescinded",
	"released",
	"fulfilled",
] as const;

/** Claims and offers (STATE_MACHINES §4). Written only by the engine. */
export const entries = sqliteTable(
	"entries",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => items.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		kind: text("kind", { enum: ENTRY_KINDS }).notNull(),
		amountCents: cents("amount_cents").notNull(),
		note: text("note"),
		status: text("status", { enum: ENTRY_STATUSES }).notNull(),
		rankOverride: integer("rank_override"),
		counterCents: cents("counter_cents"),
		counterExpiresAt: millis("counter_expires_at"),
		wonAt: millis("won_at"),
		endedAt: millis("ended_at"),
		endedReason: text("ended_reason"),
		/** A user ID or `system`. */
		endedBy: text("ended_by"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [
		index("entries_item_status").on(t.itemId, t.status, t.amountCents, t.createdAt),
		index("entries_user_status").on(t.userId, t.status),
		// One open or countered entry per buyer per item, backed by the database too.
		uniqueIndex("entries_one_pending")
			.on(t.itemId, t.userId)
			.where(sql`${t.status} IN ('open', 'countered')`),
		index("entries_counter_expiry")
			.on(t.counterExpiresAt)
			.where(sql`${t.status} = 'countered'`),
	],
);

export const takebackRequests = sqliteTable(
	"takeback_requests",
	{
		id: text("id").primaryKey(),
		entryId: text("entry_id")
			.notNull()
			.references(() => entries.id, { onDelete: "cascade" }),
		buyerId: text("buyer_id")
			.notNull()
			.references(() => users.id),
		reason: text("reason"),
		status: text("status", { enum: ["pending", "approved", "denied", "cancelled"] }).notNull(),
		createdAt: millis("created_at").notNull(),
		decidedAt: millis("decided_at"),
	},
	(t) => [index("takeback_requests_entry").on(t.entryId, t.status)],
);

/** Seller rescinds with fault attribution (STATE_MACHINES §4.3.1). */
export const rescinds = sqliteTable(
	"rescinds",
	{
		id: text("id").primaryKey(),
		entryId: text("entry_id")
			.notNull()
			.references(() => entries.id),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id),
		buyerId: text("buyer_id")
			.notNull()
			.references(() => users.id),
		reasonCode: text("reason_code").notNull(),
		explanation: text("explanation").notNull(),
		attachmentKey: text("attachment_key"),
		fault: text("fault", { enum: ["buyer", "seller", "neutral", "review"] }).notNull(),
		refundOwed: flag("refund_owed").notNull().default(false),
		refundedAt: millis("refunded_at"),
		refundRef: text("refund_ref"),
		contestedAt: millis("contested_at"),
		contestText: text("contest_text"),
		resolvedBy: text("resolved_by"),
		resolvedFault: text("resolved_fault"),
		resolvedAt: millis("resolved_at"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [
		index("rescinds_buyer").on(t.buyerId, t.createdAt),
		index("rescinds_seller").on(t.sellerId, t.createdAt),
		index("rescinds_entry").on(t.entryId),
	],
);

export const INVOICE_STATUSES = [
	"draft",
	"sent",
	"overdue",
	"buyer_paid",
	"paid",
	"shipped",
	"completed",
	"cancelled",
] as const;

/** One buyer's wins in one sale (STATE_MACHINES §6). */
export const invoices = sqliteTable(
	"invoices",
	{
		id: text("id").primaryKey(),
		saleId: text("sale_id")
			.notNull()
			.references(() => sales.id),
		buyerId: text("buyer_id")
			.notNull()
			.references(() => users.id),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id),
		/** Human-readable, per seller (tracking import matches on it). */
		invoiceNumber: integer("invoice_number"),
		status: text("status", { enum: INVOICE_STATUSES }).notNull().default("draft"),
		currency: text("currency").notNull().default("USD"),
		subtotalCents: cents("subtotal_cents").notNull().default(0),
		shippingCents: cents("shipping_cents").notNull().default(0),
		/** Discounts are negative; the total never goes below zero. */
		adjustmentCents: integer("adjustment_cents").notNull().default(0),
		totalCents: cents("total_cents").notNull().default(0),
		/** Recorded when the invoice becomes `paid` (SM-6-gmv). */
		gmvCents: cents("gmv_cents"),
		shippingOptionId: text("shipping_option_id"),
		/** Snapshot of the buyer's address at payment. */
		shippingAddress: json<Record<string, unknown>>("shipping_address"),
		paymentRef: text("payment_ref"),
		carrier: text("carrier"),
		trackingNumber: text("tracking_number"),
		sentAt: millis("sent_at"),
		dueAt: millis("due_at"),
		buyerPaidAt: millis("buyer_paid_at"),
		paidAt: millis("paid_at"),
		shippedAt: millis("shipped_at"),
		completedAt: millis("completed_at"),
		createdAt: millis("created_at").notNull(),
		updatedAt: millis("updated_at").notNull(),
	},
	(t) => [
		index("invoices_sale_buyer_status").on(t.saleId, t.buyerId, t.status),
		index("invoices_buyer").on(t.buyerId, t.status),
		uniqueIndex("invoices_seller_number")
			.on(t.sellerId, t.invoiceNumber)
			.where(sql`${t.invoiceNumber} IS NOT NULL`),
		index("invoices_status_due").on(t.status, t.dueAt),
		index("invoices_status_shipped").on(t.status, t.shippedAt),
	],
);

export const invoiceLines = sqliteTable(
	"invoice_lines",
	{
		id: text("id").primaryKey(),
		invoiceId: text("invoice_id")
			.notNull()
			.references(() => invoices.id, { onDelete: "cascade" }),
		entryId: text("entry_id")
			.notNull()
			.references(() => entries.id),
		description: text("description").notNull(),
		amountCents: cents("amount_cents").notNull(),
		refundOwed: flag("refund_owed").notNull().default(false),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [index("invoice_lines_invoice").on(t.invoiceId), index("invoice_lines_entry").on(t.entryId)],
);

/** A buyer's address book. Shown to a seller only on that buyer's invoices. */
export const addresses = sqliteTable(
	"addresses",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		line1: text("line1").notNull(),
		line2: text("line2"),
		city: text("city").notNull(),
		region: text("region").notNull(),
		postalCode: text("postal_code").notNull(),
		country: text("country").notNull().default("US"),
		isDefault: flag("is_default").notNull().default(false),
		createdAt: millis("created_at").notNull(),
		updatedAt: millis("updated_at").notNull(),
		/** Soft delete: invoices keep their own snapshot. */
		deletedAt: millis("deleted_at"),
	},
	(t) => [index("addresses_user").on(t.userId, t.deletedAt)],
);

/** Every transition writes one row in the same batch (SM-9-audit). */
export const auditLog = sqliteTable(
	"audit_log",
	{
		id: text("id").primaryKey(),
		saleId: text("sale_id"),
		itemId: text("item_id"),
		/** A user ID or `system`. */
		actorId: text("actor_id").notNull(),
		action: text("action").notNull(),
		data: json<Record<string, unknown>>("data"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [index("audit_log_sale_created").on(t.saleId, t.createdAt), index("audit_log_item").on(t.itemId)],
);

export const notifications = sqliteTable(
	"notifications",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		type: text("type").notNull(),
		payload: json<Record<string, unknown>>("payload"),
		readAt: millis("read_at"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [index("notifications_user_created").on(t.userId, t.createdAt)],
);

/** D41: follow a seller, notified of new sales. */
export const follows = sqliteTable(
	"follows",
	{
		followerId: text("follower_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.followerId, t.sellerId] }), index("follows_seller").on(t.sellerId)],
);

/** A seller blocks a user from their sales and messages. */
export const blocks = sqliteTable(
	"blocks",
	{
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		blockedUserId: text("blocked_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		reason: text("reason"),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.sellerId, t.blockedUserId] })],
);

/** Plan catalogue (PLAN §3a). The migration seeds free, seller_pro, buyer_pro and bundle. */
export const plans = sqliteTable("plans", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	/** Which sides the plan makes Pro, e.g. { "seller": "pro", "buyer": "pro" }. */
	limits: json<Record<string, unknown>>("limits").notNull().default({}),
});

/** Stripe Billing later; admin-granted Pro until then (WS-D). */
export const subscriptions = sqliteTable(
	"subscriptions",
	{
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		planId: text("plan_id")
			.notNull()
			.references(() => plans.id),
		stripeCustomerId: text("stripe_customer_id"),
		status: text("status", {
			enum: ["active", "trialing", "past_due", "canceled", "granted"],
		}).notNull(),
		/** Null for open-ended grants. */
		currentPeriodEnd: millis("current_period_end"),
		createdAt: millis("created_at").notNull(),
		updatedAt: millis("updated_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.planId] })],
);

/** The fee ledger (PLAN §3a), recorded from day one even while fees are zero. */
export const fees = sqliteTable(
	"fees",
	{
		id: text("id").primaryKey(),
		invoiceId: text("invoice_id").references(() => invoices.id),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id),
		kind: text("kind").notNull(),
		amountCents: cents("amount_cents").notNull(),
		currency: text("currency").notNull().default("USD"),
		status: text("status").notNull(),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [index("fees_seller").on(t.sellerId, t.createdAt), index("fees_invoice").on(t.invoiceId)],
);

// ---------------------------------------------------------------------------
// Import / export jobs (D57, PLAN §3c, §6 "added for import/export").

export const IO_JOB_KINDS = [
	"item_import",
	"tracking_import",
	"export_items",
	"export_orders",
	"export_shipping",
	"export_account",
] as const;
export const IO_JOB_STATUSES = ["parsed", "applying", "done", "failed", "expired"] as const;
export const IO_ROW_OUTCOMES = ["created", "updated", "skipped", "error"] as const;

/**
 * One import or export. For an item import the browser picks the id (the
 * `import_id`), so a re-sent batch finds the same job (IO-import-idempotent).
 */
export const ioJobs = sqliteTable(
	"io_jobs",
	{
		id: text("id").primaryKey(),
		sellerId: text("seller_id")
			.notNull()
			.references(() => users.id),
		saleId: text("sale_id").references(() => sales.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: IO_JOB_KINDS }).notNull(),
		status: text("status", { enum: IO_JOB_STATUSES }).notNull(),
		/** `csv` or `xlsx`. */
		format: text("format"),
		/** R2 keys of the uploaded file and the results file, when kept. */
		fileKey: text("file_key"),
		resultKey: text("result_key"),
		rowCount: integer("row_count").notNull().default(0),
		created: integer("created").notNull().default(0),
		updated: integer("updated").notNull().default(0),
		skipped: integer("skipped").notNull().default(0),
		errors: integer("errors").notNull().default(0),
		/** Items removed because the seller ticked "remove items not in file". */
		removed: integer("removed").notNull().default(0),
		createdAt: millis("created_at").notNull(),
		finishedAt: millis("finished_at"),
		expiresAt: millis("expires_at"),
	},
	(t) => [index("io_jobs_seller_created").on(t.sellerId, t.createdAt), index("io_jobs_sale").on(t.saleId)],
);

/** Each applied row of a job: its result, and the idempotency record for re-sent batches. */
export const ioJobRows = sqliteTable(
	"io_job_rows",
	{
		jobId: text("job_id")
			.notNull()
			.references(() => ioJobs.id, { onDelete: "cascade" }),
		/** The row's line in the file (the header is row 1). */
		rowNumber: integer("row_number").notNull(),
		outcome: text("outcome", { enum: IO_ROW_OUTCOMES }).notNull(),
		/** The item (or invoice) the row created or changed. */
		targetId: text("target_id"),
		/** The column an error is about ("" for the whole row). */
		field: text("field"),
		message: text("message"),
	},
	(t) => [primaryKey({ columns: [t.jobId, t.rowNumber] })],
);

/**
 * Applied rows of item imports (PLAN §3c.4): a re-sent batch with the same
 * `import_id` and row is answered from here and changes nothing (IO-import-idempotent).
 * Written only by the engine.
 */
export const importRows = sqliteTable(
	"import_rows",
	{
		importId: text("import_id").notNull(),
		/** The row's line in the seller's spreadsheet (the header is row 1). */
		row: integer("row").notNull(),
		saleId: text("sale_id")
			.notNull()
			.references(() => sales.id, { onDelete: "cascade" }),
		itemId: text("item_id").references(() => items.id, { onDelete: "set null" }),
		outcome: text("outcome", { enum: ["created", "updated", "skipped"] }).notNull(),
		createdAt: millis("created_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.importId, t.row] }), index("import_rows_sale").on(t.saleId)],
);
