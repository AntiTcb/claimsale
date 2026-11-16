/**
 * Turnstile on sign-up (TECH_STACK S41). The site key is a public var
 * (`TURNSTILE_SITE_KEY`); the secret is `TURNSTILE_SECRET_KEY`. Local development,
 * tests and isolated PR pairs use Cloudflare's published test keys, which always
 * pass (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
 */

/** Cloudflare's "always passes" test site key and secret. */
export const TEST_SITE_KEY = "1x00000000000000000000AA";
export const TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

export interface TurnstileConfig {
	readonly siteKey: string;
	readonly secretKey: string;
}

/**
 * The keys to use, or `undefined` when Turnstile isn't configured, in which case
 * email sign-up is turned off (fail closed). The test secret is only ever paired
 * with the test site key, so a real site key never runs with a secret that passes
 * everything.
 */
export function turnstileConfig(
	siteKey: string | undefined,
	secretKey: string | undefined,
): TurnstileConfig | undefined {
	const site = siteKey?.trim();
	if (!site) return undefined;
	const secret = secretKey?.trim() || (site === TEST_SITE_KEY ? TEST_SECRET_KEY : undefined);
	return secret ? { siteKey: site, secretKey: secret } : undefined;
}

/** The form field the Turnstile widget fills in. */
export const TURNSTILE_FIELD = "cf-turnstile-response";
