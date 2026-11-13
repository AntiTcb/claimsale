/**
 * Identity rules for accounts and profiles (PLAN §5 "Auth and identity", D38, D55).
 * Each validator returns the normalized value or a message for the form.
 */

export type Validated<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

const valid = <T>(value: T): Validated<T> => ({ ok: true, value });
const invalid = (message: string): Validated<never> => ({ ok: false, message });

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;

/** Handles that would collide with routes, staff or the brand. */
const RESERVED_HANDLES = new Set([
	"admin",
	"administrator",
	"api",
	"about",
	"claimsale",
	"help",
	"login",
	"logout",
	"me",
	"mod",
	"moderator",
	"null",
	"onboarding",
	"root",
	"sell",
	"settings",
	"signup",
	"staff",
	"support",
	"system",
	"undefined",
]);

/** A lowercase handle: 3–20 letters, digits or underscores, starting with a letter. */
export function validateHandle(raw: unknown): Validated<string> {
	if (typeof raw !== "string") return invalid("Choose a handle");
	const handle = raw.trim().replace(/^@/, "").toLowerCase();
	if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
		return invalid(`Handles are ${HANDLE_MIN}–${HANDLE_MAX} characters`);
	}
	if (!/^[a-z][a-z0-9_]*$/.test(handle)) {
		return invalid("Use letters, numbers and underscores, starting with a letter");
	}
	if (RESERVED_HANDLES.has(handle)) return invalid("That handle is reserved");
	return valid(handle);
}

export const DISPLAY_NAME_MAX = 50;

/** Any name people know you by: 1–50 characters, no control characters, spaces collapsed. */
export function validateDisplayName(raw: unknown): Validated<string> {
	if (typeof raw !== "string") return invalid("Enter a display name");
	// oxlint-disable-next-line no-control-regex -- control characters are exactly what is rejected
	if (/[\u0000-\u001f\u007f]/.test(raw)) return invalid("Remove the special characters");
	const name = raw.trim().replace(/\s+/g, " ");
	if (name.length === 0) return invalid("Enter a display name");
	if (name.length > DISPLAY_NAME_MAX)
		return invalid(`Display names are at most ${DISPLAY_NAME_MAX} characters`);
	return valid(name);
}

/**
 * The buyer's self-reported Facebook profile (PLAN §5 "Facebook trust"). Only
 * facebook.com / fb.com profile URLs are accepted, normalized to https://www.facebook.com/….
 */
// scheme? host path? query? fragment? — the host must end right before "/", "?", "#" or the end.
const FACEBOOK_URL =
	/^(?:https?:\/\/)?(?:www\.|m\.)?(?:facebook\.com|fb\.com)(\/[^?#\s]*)?(\?[^#\s]*)?(#\S*)?$/i;

export function validateFacebookUrl(raw: unknown): Validated<string | null> {
	if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return valid(null);
	if (typeof raw !== "string") return invalid("Enter a Facebook profile link");
	const match = FACEBOOK_URL.exec(raw.trim());
	if (!match) return invalid("Enter a facebook.com profile link");
	const path = (match[1] ?? "").replace(/\/+$/, "");
	if (path === "") return invalid("Enter the link to your profile, not the home page");
	if (path.toLowerCase() === "/profile.php") {
		const id = /(?:^\?|&)id=(\d+)(?:&|$)/.exec(match[2] ?? "")?.[1];
		if (id === undefined) return invalid("Enter the link to your profile");
		return valid(`https://www.facebook.com/profile.php?id=${id}`);
	}
	if (!/^\/[A-Za-z0-9.\-_/]+$/.test(path)) return invalid("Enter the link to your profile");
	return valid(`https://www.facebook.com${path}`);
}

export type AgeAttestation = "13+" | "18+";

/**
 * The age question at sign-up (D38): 13+ to buy, with a parent's or guardian's
 * permission under 18; 18+ to sell. Under 13 can't make an account.
 */
export function validateAge(choice: unknown, parentalConsent: unknown): Validated<AgeAttestation> {
	switch (choice) {
		case "18+":
			return valid("18+");
		case "13-17":
			return parentalConsent === true || parentalConsent === "on"
				? valid("13+")
				: invalid("Confirm that a parent or guardian said it's OK");
		case "under-13":
			return invalid("You need to be at least 13 to use ClaimSale");
		default:
			return invalid("Tell us your age range");
	}
}

/** Who may sell (D55): 18+, a verified email and, for free sellers, a verified phone. */
export function sellerBlockers(user: {
	readonly ageAttested: AgeAttestation | null;
	readonly emailVerified: boolean;
	readonly phoneVerified: boolean;
	readonly pro: boolean;
}): Array<"age" | "email" | "phone"> {
	const blockers: Array<"age" | "email" | "phone"> = [];
	if (user.ageAttested !== "18+") blockers.push("age");
	if (!user.emailVerified) blockers.push("email");
	if (!user.pro && !user.phoneVerified) blockers.push("phone");
	return blockers;
}

/** Passwords: 10–128 characters (length beats composition rules). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
