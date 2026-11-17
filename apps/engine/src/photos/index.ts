/**
 * Photo authenticity in the engine (WS-F2): the verify job runs on the engine's queue
 * as `photo_verify` messages; the web Worker requests a check over RPC after an upload,
 * and admins resolve held photos over RPC.
 */
import { Clock, Effect, Schema } from "effect";
import type { EngineEnv } from "../env.ts";
import { resolveReview, stalePendingPhotos } from "./store.ts";
import { verifyPhoto, type VerifyDeps } from "./verify.ts";

export { verifyPhoto, type VerifyDeps, type VerifyOutcome } from "./verify.ts";
export { workerDecoder } from "./wasm.ts";

/** Queue message for one upload (TECH_STACK §4: messages carry `traceparent`). */
export const PhotoVerifyMessage = Schema.Struct({
	kind: Schema.Literal("photo_verify"),
	image_id: Schema.String,
	traceparent: Schema.optional(Schema.String),
});
export type PhotoVerifyMessage = typeof PhotoVerifyMessage.Type;

export const isPhotoVerifyMessage = Schema.is(PhotoVerifyMessage);

const ImageId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const PhotoVerificationInput = Schema.Struct({ imageId: ImageId });
export type PhotoVerificationInput = typeof PhotoVerificationInput.Type;

export const PhotoReviewInput = Schema.Struct({
	imageId: ImageId,
	adminId: Schema.String.check(Schema.isMinLength(1)),
	decision: Schema.Literals(["approved", "rejected"]),
});
export type PhotoReviewInput = typeof PhotoReviewInput.Type;

const message = (imageId: string): MessageSendRequest<PhotoVerifyMessage> => ({
	body: { kind: "photo_verify", image_id: imageId },
	contentType: "json",
});

/** Queues the check of a new upload. */
export const requestVerification = (queue: Queue, input: unknown) =>
	Effect.gen(function* () {
		const { imageId } = yield* Schema.decodeUnknownEffect(PhotoVerificationInput)(input);
		const { body, contentType } = message(imageId);
		yield* Effect.tryPromise(() => queue.send(body, contentType ? { contentType } : {}));
		return true as const;
	});

/**
 * An admin's decision on a held photo. The web Worker checks the admin role first; the
 * engine records the admin's ID with the decision.
 *
 * @spec IMG-dup-review
 */
export const reviewPhoto = (db: D1Database, input: unknown) =>
	Effect.gen(function* () {
		const { imageId, adminId, decision } = yield* Schema.decodeUnknownEffect(PhotoReviewInput)(input);
		const now = yield* Clock.currentTimeMillis;
		return yield* resolveReview(db, { imageId, decision }, adminId, now);
	});

/** How long a photo may stay `pending` before the cron sends it again. */
export const STALE_PENDING_AFTER = 10 * 60_000;
/** Older pending photos are left alone (they failed repeatedly; an admin can look). */
export const STALE_PENDING_WINDOW = 24 * 60 * 60_000;
const STALE_PENDING_BATCH = 100;

/** Cron backstop: re-queues photos still `pending` after STALE_PENDING_AFTER. */
export const requeueStalePhotos = (env: Pick<EngineEnv, "DB" | "NOTIFICATIONS">) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const ids = yield* stalePendingPhotos(
			env.DB,
			now - STALE_PENDING_AFTER,
			now - STALE_PENDING_WINDOW,
			STALE_PENDING_BATCH,
		);
		if (ids.length > 0) yield* Effect.tryPromise(() => env.NOTIFICATIONS.sendBatch(ids.map(message)));
		yield* Effect.logInfo("stale pending photos re-queued").pipe(Effect.annotateLogs({ count: ids.length }));
		return ids.length;
	});

/**
 * Handles one `photo_verify` message: ack once decided or skipped, retry on a D1 or R2
 * failure (the queue's max_retries bounds it; the cron re-queues what's left pending).
 */
export const handlePhotoMessage = (message: Message, body: PhotoVerifyMessage, deps: VerifyDeps) =>
	verifyPhoto(deps, body.image_id).pipe(
		Effect.andThen(Effect.sync(() => message.ack())),
		Effect.catchTags({
			PhotoDbError: (error) =>
				Effect.logWarning("photo verify failed; will retry", error).pipe(
					Effect.andThen(Effect.sync(() => message.retry())),
				),
			PhotoStoreError: (error) =>
				Effect.logWarning("photo verify failed; will retry", error).pipe(
					Effect.andThen(Effect.sync(() => message.retry())),
				),
		}),
		Effect.annotateLogs({ queue_message_id: message.id }),
	);
