import { emailOutbox } from "@claimsale/db/schema";
import type { Db } from "@claimsale/db";
import { uuidv7 } from "uuidv7";

/**
 * Auth email from the web Worker (TECH_STACK §10): verification, magic links and
 * password resets go out directly, never behind the notification queue.
 */

export interface Mail {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly html: string;
}

export interface Mailer {
	readonly mode: MailerMode;
	send(mail: Mail): Promise<void>;
}

export type MailerMode = "cloudflare" | "capture";

/** The one `send_email` overload the mailer uses (the real binding satisfies it). */
export interface EmailBinding {
	send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}

export interface MailerDeps {
	readonly mode: string;
	readonly from: string;
	readonly binding: EmailBinding;
	readonly db: Db;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

/**
 * `cloudflare` sends through Email Service. `capture` writes the message to the
 * `email_outbox` table so E2E tests can follow links, and logs only the subject.
 * Any other value fails closed to `cloudflare`, so a typo can't capture real mail.
 */
export function makeMailer(deps: MailerDeps): Mailer {
	const now = deps.now ?? Date.now;
	// oxlint-disable-next-line no-console -- one structured line, no address or body
	const log = deps.log ?? ((line: string) => console.log(line));
	if (deps.mode === "capture") {
		return {
			mode: "capture",
			async send(mail) {
				await deps.db.insert(emailOutbox).values({
					id: uuidv7(),
					to: mail.to.toLowerCase(),
					subject: mail.subject,
					text: mail.text,
					html: mail.html,
					createdAt: now(),
				});
				log(JSON.stringify({ level: "info", msg: "email captured", subject: mail.subject }));
			},
		};
	}
	return {
		mode: "cloudflare",
		async send(mail) {
			await deps.binding.send({
				from: deps.from,
				to: mail.to,
				subject: mail.subject,
				text: mail.text,
				html: mail.html,
			});
		},
	};
}
