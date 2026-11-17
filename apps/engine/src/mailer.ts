import { Context, Data, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";

export interface OutgoingMail {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly html?: string;
}

export class MailError extends Data.TaggedError("MailError")<{ readonly cause: unknown }> {}

/**
 * Sends email (TECH_STACK §10). The engine sends notifications from the queue
 * consumer; this is the only code that touches the `send_email` binding.
 */
export class Mailer extends Context.Service<
	Mailer,
	{ readonly send: (mail: OutgoingMail) => Effect.Effect<{ readonly messageId: string }, MailError> }
>()("claimsale/Mailer") {}

/** Cloudflare Email Service. Locally, wrangler simulates the binding and writes the message to a file. */
export const CloudflareMailer = (binding: SendEmail, from: string) =>
	Layer.succeed(Mailer, {
		send: (mail) =>
			Effect.tryPromise({
				try: () =>
					binding.send({
						from,
						to: mail.to,
						subject: mail.subject,
						text: mail.text,
						...(mail.html === undefined ? {} : { html: mail.html }),
					}),
				catch: (cause) => new MailError({ cause }),
			}).pipe(Effect.withSpan("mail.send", { attributes: { "mail.subject": mail.subject } })),
	});

/**
 * The CapturingMailer (TECH_STACK §10): writes each message to `email_outbox` instead of
 * sending it, so E2E tests read notification email through `GET /api/test/outbox`, like
 * the web Worker's auth email. Used where `MAILER` is `capture` (local, tests, PR pairs).
 */
export const CapturingMailer = (db: D1Database, now: () => number = Date.now) =>
	Layer.succeed(Mailer, {
		send: (mail) =>
			Effect.tryPromise({
				try: async () => {
					const id = uuidv7();
					await db
						.prepare(
							"INSERT INTO email_outbox (id, to_address, subject, text, html, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
						)
						.bind(id, mail.to.toLowerCase(), mail.subject, mail.text, mail.html ?? null, now())
						.run();
					return { messageId: id };
				},
				catch: (cause) => new MailError({ cause }),
			}).pipe(Effect.withSpan("mail.capture", { attributes: { "mail.subject": mail.subject } })),
	});

/** `capture` captures; anything else sends, so a typo can't swallow real mail (fails closed). */
export function mailerFor(env: { MAILER: string; EMAIL: SendEmail; MAIL_FROM: string; DB: D1Database }) {
	return env.MAILER === "capture" ? CapturingMailer(env.DB) : CloudflareMailer(env.EMAIL, env.MAIL_FROM);
}
