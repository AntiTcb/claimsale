import { APIError } from "better-auth/api";

/** A form field as a string ("" when missing or a file). */
export function field(data: FormData, name: string): string {
	const value = data.get(name);
	return typeof value === "string" ? value : "";
}

/** Better Auth error codes shown to people, in our words. Anything else gets a generic message. */
const MESSAGES: Record<string, string> = {
	USER_ALREADY_EXISTS: "An account with this email already exists. Sign in instead.",
	USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "An account with this email already exists. Sign in instead.",
	INVALID_EMAIL_OR_PASSWORD: "That email and password don't match.",
	INVALID_EMAIL: "Enter a valid email address.",
	PASSWORD_TOO_SHORT: "Use at least 10 characters for your password.",
	PASSWORD_TOO_LONG: "Use at most 128 characters for your password.",
	INVALID_TOKEN: "This link has expired or was already used. Ask for a new one.",
	TOO_MANY_REQUESTS: "Too many attempts. Wait a minute and try again.",
};

export function authErrorMessage(error: unknown): string {
	if (error instanceof APIError) {
		if (error.statusCode === 429) return MESSAGES["TOO_MANY_REQUESTS"]!;
		const code = typeof error.body?.code === "string" ? error.body.code : "";
		return MESSAGES[code] ?? "Something went wrong. Try again.";
	}
	return "Something went wrong. Try again.";
}

export function isApiError(error: unknown): error is APIError {
	return error instanceof APIError;
}

/** Field errors for the account forms; `form` is the message for the whole form. */
export type FormErrors = Partial<
	Record<"form" | "displayName" | "handle" | "email" | "password" | "age" | "fbProfileUrl", string>
>;

export const formError = (message: string): FormErrors => ({ form: message });
export const fieldError = (name: keyof FormErrors, message: string): FormErrors => ({ [name]: message });
