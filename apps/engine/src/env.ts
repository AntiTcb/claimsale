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
	readonly APP_ENV: string;
	readonly VERSION: string;
	/** Sender for notification email (TECH_STACK S31). */
	readonly MAIL_FROM: string;
	/** Sentry DSN for error reports; empty disables reporting. A DSN is public by design. */
	readonly SENTRY_DSN: string;
	/** TCGCSV base URL for the catalog ingestion (TECH_STACK S32). */
	readonly TCGCSV_BASE_URL: string;
	/** Sets (TCGCSV groups) ingested per run, as a decimal string. */
	readonly CATALOG_GROUPS_PER_RUN: string;
}
