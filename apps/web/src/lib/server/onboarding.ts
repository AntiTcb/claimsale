/**
 * Every account needs a handle and an age attestation (D38) before using the site.
 * Sign-ups through the form provide both; Discord and magic-link sign-ups finish
 * them on /onboarding.
 */

export interface IdentityFields {
	readonly handle?: string | null | undefined;
	readonly ageAttested?: string | null | undefined;
}

export function needsOnboarding(user: IdentityFields | null): boolean {
	return user !== null && (!user.handle || (user.ageAttested !== "13+" && user.ageAttested !== "18+"));
}

const EXEMPT_PREFIXES = ["/onboarding", "/api/", "/logout", "/_app/", "/u/", "/legal"];
const EXEMPT_EXACT = new Set(["/", "/favicon.ico", "/robots.txt"]);

/** Pages an account that hasn't finished onboarding can still open. */
export function isOnboardingExempt(pathname: string): boolean {
	return EXEMPT_EXACT.has(pathname) || EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Only same-site paths are followed after sign-in, never another origin. */
export function safeRedirect(target: unknown, fallback = "/"): string {
	if (
		typeof target !== "string" ||
		!target.startsWith("/") ||
		target.startsWith("//") ||
		target.startsWith("/\\")
	) {
		return fallback;
	}
	return target;
}
