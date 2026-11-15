import type { Mail } from "./mailer.ts";

/**
 * Auth email content. Plain text plus a minimal HTML version; the Svelte email
 * templates (TECH_STACK §2, packages/emails) replace these with the notification work.
 */

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function render(
	to: string,
	subject: string,
	intro: string,
	action: string,
	url: string,
	outro: string,
): Mail {
	const text = `${intro}\n\n${action}: ${url}\n\n${outro}\n\n— ClaimSale`;
	const html = [
		`<p>${escapeHtml(intro)}</p>`,
		`<p><a href="${escapeHtml(url)}">${escapeHtml(action)}</a></p>`,
		`<p style="color:#555">${escapeHtml(outro)}</p>`,
		"<p>— ClaimSale</p>",
	].join("\n");
	return { to, subject, text, html };
}

export function verificationEmail(to: string, url: string): Mail {
	return render(
		to,
		"Confirm your email for ClaimSale",
		"Confirm this email address to start claiming items.",
		"Confirm email",
		url,
		"If you didn't create a ClaimSale account, you can ignore this email.",
	);
}

export function magicLinkEmail(to: string, url: string): Mail {
	return render(
		to,
		"Your ClaimSale sign-in link",
		"Use this link to sign in. It works once and expires in 5 minutes.",
		"Sign in",
		url,
		"If you didn't ask to sign in, you can ignore this email.",
	);
}

export function passwordResetEmail(to: string, url: string): Mail {
	return render(
		to,
		"Reset your ClaimSale password",
		"Someone asked to reset the password for this account.",
		"Choose a new password",
		url,
		"If it wasn't you, ignore this email; your password stays the same.",
	);
}
