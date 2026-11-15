import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
