import { parseTraceparent } from "@claimsale/observability";
import { Effect, Option, Schema, Tracer } from "effect";
import { handleExportMessage, isExportJobMessage, type ExportDeps } from "./exports/index.ts";
import { Mailer } from "./mailer.ts";
import { handlePhotoMessage, isPhotoVerifyMessage, type VerifyDeps } from "./photos/index.ts";

/** Queue message envelope (TECH_STACK §4: messages carry `traceparent`). */
export const NotificationMessage = Schema.Struct({
	kind: Schema.Literal("trace_probe"),
	probe_id: Schema.String,
	traceparent: Schema.optional(Schema.String),
});
export type NotificationMessage = typeof NotificationMessage.Type;

/**
 * Domain events a SaleEngine committed (STATE_MACHINES §9). WS-K turns them into
 * notifications; until then the consumer acknowledges them.
 */
export const SaleEventsMessage = Schema.Struct({
	kind: Schema.Literal("sale_events"),
	sale_id: Schema.String,
	events: Schema.Array(Schema.Unknown),
	traceparent: Schema.optional(Schema.String),
});
export type SaleEventsMessage = typeof SaleEventsMessage.Type;

const decodeSaleEvents = Schema.decodeUnknownOption(SaleEventsMessage);

export interface QueueOptions {
	/** Where trace probe emails go; unset means the probe stops at the consumer. */
	readonly probeRecipient: string | undefined;
	/** The photo verify job's bindings (WS-F2); without them `photo_verify` messages are retried. */
	readonly photos?: VerifyDeps;
	/** The export job's bindings (WS-J); without them `export_job` messages are retried. */
	readonly exports?: ExportDeps;
}

const decodeMessage = Schema.decodeUnknownOption(NotificationMessage);

/** Links the consumer's span to the producer's span from the message's `traceparent`. */
function producerLinks(traceparent: string | undefined): Tracer.SpanLink[] {
	const parent = parseTraceparent(traceparent);
	return parent
		? [
				{
					span: Tracer.externalSpan({
						traceId: parent.traceId,
						spanId: parent.spanId,
						sampled: parent.sampled,
					}),
					attributes: {},
				},
			]
		: [];
}

const handleTraceProbe = (message: Message, body: NotificationMessage, options: QueueOptions) =>
	Effect.gen(function* () {
		const to = options.probeRecipient;
		if (to === undefined) {
			yield* Effect.logInfo("trace probe consumed; no recipient set, so no email sent");
		} else {
			const mailer = yield* Mailer;
			const sent = yield* mailer.send({
				to,
				subject: `ClaimSale trace probe ${body.probe_id}`,
				text: `Trace probe ${body.probe_id} reached the notifications consumer.`,
			});
			yield* Effect.logInfo("trace probe email sent").pipe(
				Effect.annotateLogs({ message_id: sent.messageId }),
			);
		}
		message.ack();
	}).pipe(
		Effect.catchTag("MailError", (error) =>
			Effect.logWarning("trace probe email failed; will retry", error.cause).pipe(
				Effect.andThen(Effect.sync(() => message.retry())),
			),
		),
		Effect.annotateLogs({ probe_id: body.probe_id, queue_message_id: message.id }),
		Effect.withSpan("engine.notifications.trace_probe", {
			links: producerLinks(body.traceparent),
			attributes: { probe_id: body.probe_id, "queue.attempts": message.attempts },
		}),
	);

export const handleQueue = (batch: MessageBatch, options: QueueOptions) =>
	Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ queue: batch.queue, "queue.batch_size": batch.messages.length });
		for (const message of batch.messages) {
			// Photo checks share this queue (WS-F2), so no new queue has to be provisioned.
			if (isPhotoVerifyMessage(message.body)) {
				if (options.photos) yield* handlePhotoMessage(message, message.body, options.photos);
				else message.retry();
				continue;
			}
			// So do seller exports (WS-J).
			if (isExportJobMessage(message.body)) {
				if (options.exports) yield* handleExportMessage(message, message.body, options.exports);
				else message.retry();
				continue;
			}
			const saleEvents = decodeSaleEvents(message.body);
			if (Option.isSome(saleEvents)) {
				yield* Effect.logDebug("sale events received; no notification handlers yet").pipe(
					Effect.annotateLogs({ sale_id: saleEvents.value.sale_id, events: saleEvents.value.events.length }),
				);
				message.ack();
				continue;
			}
			const body = decodeMessage(message.body);
			if (Option.isNone(body)) {
				// Milestone 9 adds the real notification kinds. Unknown messages can't be
				// handled by retrying, so they are acknowledged and logged.
				yield* Effect.logWarning("unknown notification message dropped").pipe(
					Effect.annotateLogs({ queue_message_id: message.id }),
				);
				message.ack();
				continue;
			}
			yield* handleTraceProbe(message, body.value, options);
		}
	});

export const handleScheduled = (controller: ScheduledController) =>
	Effect.logInfo("timer sweep").pipe(Effect.annotateLogs({ cron: controller.cron }));
