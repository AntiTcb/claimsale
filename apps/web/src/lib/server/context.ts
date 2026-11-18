import { createDb, type Db } from "@claimsale/db";
import { env } from "cloudflare:workers";
import { authSecret, createAuth, type Auth } from "./auth.ts";
import { rpcEngine, type Engine } from "./engine.ts";
import type { ImageStore } from "./images.ts";
import { invoiceCommands, type InvoiceCommands } from "./invoices.ts";
import { makeMailer, type Mailer } from "./mailer.ts";
import type { NotifyRpc } from "./notify-rpc.ts";
import { makePhoneVerifier, type PhoneVerifier } from "./sms.ts";
import { turnstileConfig, type TurnstileConfig } from "./turnstile.ts";

/**
 * Per-isolate services wired to `cloudflare:workers` bindings. Kept thin: the
 * logic lives in auth.ts, mailer.ts, sms.ts and users.ts, which take these as arguments.
 */

type OptionalSecret =
	| "DISCORD_CLIENT_ID"
	| "DISCORD_CLIENT_SECRET"
	| "TURNSTILE_SECRET_KEY"
	| "TWILIO_API_KEY_SID"
	| "TWILIO_API_KEY_SECRET"
	| "TWILIO_VERIFY_SERVICE_SID";

/** Optional secrets, set in `.dev.vars` or as Worker secrets, absent by default. */
function optional(name: OptionalSecret): string | undefined {
	const value: unknown = Reflect.get(env, name);
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function db(): Db {
	return createDb(env.DB);
}

/** Seller photos in R2 (private; served through /api/images/[imageId]). */
export function imageStore(): ImageStore {
	return env.IMAGES;
}

/** The sale engine: the SaleEngine Durable Object over the ENGINE service binding (RPC). */
export function engine(): Engine {
	return rpcEngine(env.ENGINE);
}

/** The engine Worker's RPC binding for the catalog type-ahead, item import batches and exports. */
export function engineRpc(): Pick<Env["ENGINE"], "searchCatalog" | "applyImportBatch" | "requestExport"> {
	return env.ENGINE;
}

/** The engine's notification RPC (messages, invite lists; WS-K). */
export function notifyRpc(): NotifyRpc {
	return env.ENGINE;
}

/** Invoice commands through the sale engine (WS-J). */
export function invoiceEngine(): InvoiceCommands {
	return invoiceCommands(env.ENGINE);
}

/** The key for sale unlock cookies (shared with Better Auth's signing secret). */
export function cookieSecret(): string {
	return authSecret(env.APP_ENV, env.BETTER_AUTH_SECRET);
}

export function mailer(): Mailer {
	return makeMailer({ mode: env.MAILER, from: env.MAIL_FROM, binding: env.EMAIL, db: db() });
}

export function phoneVerifier(): PhoneVerifier {
	const apiKeySid = optional("TWILIO_API_KEY_SID");
	const apiKeySecret = optional("TWILIO_API_KEY_SECRET");
	const verifyServiceSid = optional("TWILIO_VERIFY_SERVICE_SID");
	return makePhoneVerifier({
		mode: env.SMS,
		db: db(),
		twilio:
			apiKeySid && apiKeySecret && verifyServiceSid
				? { apiKeySid, apiKeySecret, verifyServiceSid }
				: undefined,
	});
}

export function turnstile(): TurnstileConfig | undefined {
	return turnstileConfig(env.TURNSTILE_SITE_KEY, optional("TURNSTILE_SECRET_KEY"));
}

export function discordConfigured(): boolean {
	return optional("DISCORD_CLIENT_ID") !== undefined && optional("DISCORD_CLIENT_SECRET") !== undefined;
}

const instances = new Map<string, Auth>();

/** One Better Auth instance per origin (a Worker can be reached on several hostnames). */
export function auth(origin: string): Auth {
	let instance = instances.get(origin);
	if (!instance) {
		const clientId = optional("DISCORD_CLIENT_ID");
		const clientSecret = optional("DISCORD_CLIENT_SECRET");
		const captcha = turnstile();
		instance = createAuth({
			db: db(),
			mailer: mailer(),
			origin,
			secret: authSecret(env.APP_ENV, env.BETTER_AUTH_SECRET),
			discord: clientId && clientSecret ? { clientId, clientSecret } : undefined,
			captcha: captcha ? { secretKey: captcha.secretKey } : undefined,
			throwawayData: outboxEnabled(),
		});
		instances.set(origin, instance);
	}
	return instance;
}

/** Test endpoints are only on where nothing real is sent and the data is throwaway. */
const sharedData = () => env.APP_ENV === "production" || env.APP_ENV === "staging";

/** Whether the test-only outbox endpoint is on: captured mail, and never on shared data. */
export function outboxEnabled(): boolean {
	return env.MAILER === "capture" && !sharedData();
}

/** Whether the test-only SMS code endpoint is on: captured codes, and never on shared data. */
export function smsCaptureEnabled(): boolean {
	return env.SMS === "capture" && !sharedData();
}
