import { createDb, type Db } from "@claimsale/db";
import { env } from "cloudflare:workers";
import { authSecret, createAuth, type Auth } from "./auth.ts";
import { makeMailer, type Mailer } from "./mailer.ts";

/**
 * Per-isolate services wired to `cloudflare:workers` bindings. Kept thin: the
 * logic lives in auth.ts, mailer.ts and users.ts, which take these as arguments.
 */

/** Optional secrets, set with `wrangler secret put`, absent by default. */
function optional(name: "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET"): string | undefined {
	const value: unknown = Reflect.get(env, name);
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function db(): Db {
	return createDb(env.DB);
}

export function mailer(): Mailer {
	return makeMailer({ mode: env.MAILER, from: env.MAIL_FROM, binding: env.EMAIL, db: db() });
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
		instance = createAuth({
			db: db(),
			mailer: mailer(),
			origin,
			secret: authSecret(env.APP_ENV, env.BETTER_AUTH_SECRET),
			discord: clientId && clientSecret ? { clientId, clientSecret } : undefined,
		});
		instances.set(origin, instance);
	}
	return instance;
}

/** Whether the test-only outbox endpoint is on: captured mail, and never on shared data. */
export function outboxEnabled(): boolean {
	return env.MAILER === "capture" && env.APP_ENV !== "production" && env.APP_ENV !== "staging";
}
