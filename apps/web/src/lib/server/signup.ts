import type { Auth } from "./auth.ts";
import { authCodeMessage } from "./forms.ts";

/**
 * Email sign-up from the form action. Better Auth's captcha plugin (and its rate
 * limiter) run in the router, not in `auth.api.*`, so the form posts to
 * `/sign-up/email` through `auth.handler` with the widget's token in
 * `x-captcha-response`. The API endpoint and the form share one check.
 *
 * @spec AUTH-signup-captcha — sign-up through the form needs a passing Turnstile check.
 */

export interface SignUpInput {
	readonly name: string;
	readonly email: string;
	readonly password: string;
	readonly callbackURL: string;
}

export type SignUpResult =
	| { readonly ok: true; readonly userId: string; readonly headers: Headers }
	| { readonly ok: false; readonly message: string };

function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Request headers worth passing on: the client address (rate limits, Turnstile) and agent. */
const FORWARDED = ["cf-connecting-ip", "user-agent", "accept-language"];

export async function signUpWithCaptcha(
	auth: Pick<Auth, "handler">,
	request: Request,
	origin: string,
	input: SignUpInput,
	captchaToken: string,
): Promise<SignUpResult> {
	const headers = new Headers({ "content-type": "application/json", origin });
	for (const name of FORWARDED) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	if (captchaToken) headers.set("x-captcha-response", captchaToken);
	const response = await auth.handler(
		new Request(`${origin}/api/auth/sign-up/email`, {
			method: "POST",
			headers,
			body: JSON.stringify(input),
		}),
	);
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok) return { ok: false, message: authCodeMessage(response.status, prop(body, "code")) };
	const userId = prop(prop(body, "user"), "id");
	if (typeof userId !== "string") return { ok: false, message: authCodeMessage(500, undefined) };
	return { ok: true, userId, headers: response.headers };
}
