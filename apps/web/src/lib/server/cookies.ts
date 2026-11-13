import type { Cookies } from "@sveltejs/kit";

/**
 * Better Auth's server API returns `Set-Cookie` headers; SvelteKit form actions
 * set cookies through `event.cookies`. This copies one onto the other, value
 * unchanged, so sign-in works from plain HTML forms without client JavaScript.
 */

export interface ParsedCookie {
	readonly name: string;
	readonly value: string;
	readonly options: {
		path: string;
		httpOnly: boolean;
		secure: boolean;
		sameSite?: "lax" | "strict" | "none";
		maxAge?: number;
		expires?: Date;
		domain?: string;
	};
}

export function parseSetCookie(header: string): ParsedCookie | undefined {
	const [pair, ...attributes] = header.split(";");
	const eq = pair?.indexOf("=") ?? -1;
	if (pair === undefined || eq <= 0) return undefined;
	const options: ParsedCookie["options"] = { path: "/", httpOnly: false, secure: false };
	for (const attribute of attributes) {
		const [rawKey = "", ...rest] = attribute.split("=");
		const key = rawKey.trim().toLowerCase();
		const value = rest.join("=").trim();
		if (key === "path") options.path = value || "/";
		else if (key === "httponly") options.httpOnly = true;
		else if (key === "secure") options.secure = true;
		else if (key === "samesite") {
			const same = value.toLowerCase();
			if (same === "lax" || same === "strict" || same === "none") options.sameSite = same;
		} else if (key === "max-age" && /^-?\d+$/.test(value)) options.maxAge = Number(value);
		else if (key === "expires") {
			const date = new Date(value);
			if (!Number.isNaN(date.getTime())) options.expires = date;
		} else if (key === "domain" && value) options.domain = value;
	}
	return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), options };
}

/** Applies every `Set-Cookie` in `headers` to the SvelteKit response. */
export function forwardCookies(headers: Headers, cookies: Pick<Cookies, "set">): void {
	for (const header of headers.getSetCookie()) {
		const cookie = parseSetCookie(header);
		if (!cookie) continue;
		// Better Auth already encoded the value; don't encode it again.
		cookies.set(cookie.name, cookie.value, { ...cookie.options, encode: (v: string) => v });
	}
}
