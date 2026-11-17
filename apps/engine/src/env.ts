import type { SaleEngine } from "./sale-engine.ts";

/**
 * The engine's bindings, declared explicitly instead of using the global `Env`
 * from `wrangler types`. Other Workers type-check this source through their
 * service bindings, and in their programs the global `Env` is theirs, not ours.
 * `env-check.ts` keeps this in sync with the generated type.
 */
export interface EngineEnv {
	readonly DB: D1Database;
	readonly SALE_ENGINE: DurableObjectNamespace<SaleEngine>;
	/** Notifications, and the photo verify job's `photo_verify` messages (WS-F2). */
	readonly NOTIFICATIONS: Queue;
	/** Seller photos (the web Worker's bucket), read by the photo verify job. */
	readonly IMAGES: R2Bucket;
	readonly EMAIL: SendEmail;
	/** Claims and offers per buyer (SM-9-entry-rate-limit). */
	readonly ENTRY_LIMITER: RateLimit;
	readonly APP_ENV: string;
	readonly VERSION: string;
	/** Sender for notification email (TECH_STACK S31). */
	readonly MAIL_FROM: string;
	/**
	 * `capture` writes notification email to `email_outbox` (local, tests, PR pairs; E2E reads it);
	 * `cloudflare` sends it. Anything else fails closed to `cloudflare` (TECH_STACK §10, S40).
	 */
	readonly MAILER: string;
	/** The web app's origin for links in email, e.g. `https://claimsale.net`; empty → site-relative links. */
	readonly SITE_URL: string;
	/** Sentry DSN for error reports; empty disables reporting. A DSN is public by design. */
	readonly SENTRY_DSN: string;
	/** TCGCSV base URL for the catalog ingestion (TECH_STACK S32). */
	readonly TCGCSV_BASE_URL: string;
	/** Sets (TCGCSV groups) ingested per run, as a decimal string. */
	readonly CATALOG_GROUPS_PER_RUN: string;
}
