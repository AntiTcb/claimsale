import { Context, Data, Effect, Layer } from "effect";

export interface OutgoingMail {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
}

export class MailError extends Data.TaggedError("MailError")<{ readonly cause: unknown }> {}

/**
 * Sends email (TECH_STACK §10). The engine sends notifications from the queue
 * consumer; this is the only code that touches the `send_email` binding.
 * Milestone 9 adds the capturing implementation for previews and E2E tests.
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
				try: () => binding.send({ from, to: mail.to, subject: mail.subject, text: mail.text }),
				catch: (cause) => new MailError({ cause }),
			}).pipe(Effect.withSpan("mail.send", { attributes: { "mail.subject": mail.subject } })),
	});
