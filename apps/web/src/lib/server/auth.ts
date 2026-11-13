import { PASSWORD_MAX, PASSWORD_MIN } from "@claimsale/core";
import type { Db } from "@claimsale/db";
import { authAccounts, rateLimits, sessions, users, verifications } from "@claimsale/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { uuidv7 } from "uuidv7";
import { magicLinkEmail, passwordResetEmail, verificationEmail } from "./emails.ts";
import type { Mailer } from "./mailer.ts";

/**
 * Better Auth for the web Worker (TECH_STACK S8/S9): email + password with email
 * verification, magic links, password reset, and Discord when its credentials are
 * set. Users and sessions live in D1 (packages/db schema).
 */

export interface AuthDeps {
	readonly db: Db;
	readonly mailer: Mailer;
	/** The site origin, e.g. https://staging.claimsale.net. */
	readonly origin: string;
	readonly secret: string;
	readonly discord?: { readonly clientId: string; readonly clientSecret: string } | undefined;
}

/** Fields Better Auth may never set from a request body: they go through our own validated forms. */
const text = { type: "string", required: false, input: false } as const;
const date = { type: "date", required: false, input: false } as const;

export function createAuth(deps: AuthDeps) {
	const send = (mail: Parameters<Mailer["send"]>[0]) => deps.mailer.send(mail);
	return betterAuth({
		appName: "ClaimSale",
		baseURL: deps.origin,
		basePath: "/api/auth",
		secret: deps.secret,
		trustedOrigins: [deps.origin],
		database: drizzleAdapter(deps.db, {
			provider: "sqlite",
			schema: {
				user: users,
				session: sessions,
				account: authAccounts,
				verification: verifications,
				rateLimit: rateLimits,
			},
		}),
		user: {
			fields: { name: "displayName" },
			additionalFields: {
				handle: text,
				ageAttested: text,
				ageAttestedAt: date,
				fbProfileUrl: text,
				country: text,
				phoneE164: text,
				phoneVerifiedAt: date,
			},
		},
		// No session cookie cache: handle and age are written straight to D1 after sign-up
		// and onboarding, and a cached copy would be stale. One D1 read per page view.
		account: {
			accountLinking: { enabled: true, trustedProviders: ["discord"] },
		},
		emailAndPassword: {
			enabled: true,
			minPasswordLength: PASSWORD_MIN,
			maxPasswordLength: PASSWORD_MAX,
			// D20: verification is needed to claim, not to sign in.
			requireEmailVerification: false,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: ({ user, url }) => send(passwordResetEmail(user.email, url)),
		},
		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			sendVerificationEmail: ({ user, url }) => send(verificationEmail(user.email, url)),
		},
		socialProviders: deps.discord
			? { discord: { clientId: deps.discord.clientId, clientSecret: deps.discord.clientSecret } }
			: {},
		plugins: [
			magicLink({
				expiresIn: 5 * 60,
				sendMagicLink: ({ email, url }) => send(magicLinkEmail(email, url)),
			}),
		],
		rateLimit: {
			enabled: true,
			storage: "database",
			window: 60,
			max: 100,
			customRules: {
				"/sign-in/email": { window: 60, max: 5 },
				"/sign-up/email": { window: 60, max: 5 },
				"/sign-in/magic-link": { window: 60, max: 3 },
				"/request-password-reset": { window: 60, max: 3 },
				"/send-verification-email": { window: 60, max: 3 },
			},
		},
		advanced: {
			cookiePrefix: "cs",
			useSecureCookies: deps.origin.startsWith("https://"),
			database: { generateId: () => uuidv7() },
			// Workers see the client address in this header.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
		},
		telemetry: { enabled: false },
	});
}

/** Only for environments with throwaway data; staging and production must set the secret. */
const LOCAL_SECRET = "claimsale-local-development-secret-not-for-deployed-workers";

export function authSecret(appEnv: string, secret: string | undefined): string {
	if (secret) return secret;
	if (appEnv === "local" || appEnv === "test") return LOCAL_SECRET;
	throw new Error("BETTER_AUTH_SECRET is not set");
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth["$Infer"]["Session"]["user"];
