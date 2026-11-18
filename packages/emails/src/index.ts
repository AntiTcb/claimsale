import { render } from "svelte/server";
import DigestEmail from "./generated/DigestEmail.js";
import InviteEmail from "./generated/InviteEmail.js";
import NotificationEmail from "./generated/NotificationEmail.js";
import type { DigestEmailProps, InviteEmailProps, NotificationEmailProps } from "./types.ts";

/**
 * Notification email content (TECH_STACK §2, §10): HTML rendered from the Svelte templates
 * in src/templates (compiled into src/generated), plus a plain-text version of the same words.
 * The engine's queue consumer sends these; nothing here touches the network.
 */

export type { DigestEmailProps, InviteEmailProps, NotificationEmailProps } from "./types.ts";

export interface EmailContent {
	readonly subject: string;
	readonly text: string;
	readonly html: string;
}

const SIGNATURE = "— ClaimSale";

function page(body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0">${body}</body></html>`;
}

const footer = (preferencesUrl: string) => `Choose which emails you get: ${preferencesUrl}`;

/** One notification: a title, a sentence and a button. */
export function notificationEmail(props: NotificationEmailProps): EmailContent {
	const { body } = render(NotificationEmail, { props });
	return {
		subject: props.title,
		text: [props.body, `${props.actionLabel}: ${props.url}`, SIGNATURE, footer(props.preferencesUrl)].join(
			"\n\n",
		),
		html: page(body),
	};
}

/** A batch of activity in one email (a seller's digest). */
export function digestEmail(props: DigestEmailProps & { readonly subject: string }): EmailContent {
	const { subject, ...rest } = props;
	const { body } = render(DigestEmail, { props: rest });
	return {
		subject,
		text: [
			props.heading,
			props.lines.map((line) => `- ${line}`).join("\n"),
			`${props.actionLabel}: ${props.url}`,
			SIGNATURE,
			footer(props.preferencesUrl),
		].join("\n\n"),
		html: page(body),
	};
}

/** An invitation to a private sale for an address on its invite list (D5). */
export function inviteEmail(props: InviteEmailProps): EmailContent {
	const { body } = render(InviteEmail, { props });
	return {
		subject: `You're invited to a private sale: ${props.saleTitle}`,
		text: [
			`${props.sellerName} added this email address to the invite list of a private claim sale, “${props.saleTitle}”${props.when ? `, which goes live ${props.when}` : ""}.`,
			"Sign in or create an account with this email address and confirm it to see the sale.",
			`Open the sale: ${props.url}`,
			SIGNATURE,
		].join("\n\n"),
		html: page(body),
	};
}
