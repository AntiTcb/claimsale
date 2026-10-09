import { Effect } from "effect";

export const handleQueue = (batch: MessageBatch) =>
	Effect.logInfo("notification batch received").pipe(
		Effect.annotateLogs({ queue: batch.queue, size: batch.messages.length }),
		// Milestone 9 sends the notifications; until then nothing should be enqueued.
		Effect.andThen(Effect.sync(() => batch.ackAll())),
		Effect.withSpan("engine.queue.notifications"),
	);

export const handleScheduled = (controller: ScheduledController) =>
	Effect.logInfo("timer sweep").pipe(
		Effect.annotateLogs({ cron: controller.cron }),
		Effect.withSpan("engine.cron.sweep"),
	);
