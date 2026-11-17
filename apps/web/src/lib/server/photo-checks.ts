import { Effect } from "effect";

/**
 * The engine's photo authenticity RPC (WS-F2), as seen from the web Worker: queue the
 * duplicate check of a new upload, and record an admin's decision on a held photo.
 */

type RpcResult<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly error: { readonly name: string; readonly message: string } };

/** The engine methods used here (the ENGINE service binding has them). */
export interface PhotoRpc {
	requestPhotoVerification(input: { imageId: string }): Promise<RpcResult<true>>;
	reviewPhoto(input: {
		imageId: string;
		adminId: string;
		decision: "approved" | "rejected";
	}): Promise<RpcResult<boolean>>;
}

class PhotoRpcError extends Error {
	override readonly name = "PhotoRpcError";
}

const call = <A>(run: () => Promise<RpcResult<A>>) =>
	Effect.tryPromise({ try: run, catch: (cause) => new PhotoRpcError(String(cause)) }).pipe(
		Effect.flatMap((result) =>
			result.ok ? Effect.succeed(result.value) : Effect.fail(new PhotoRpcError(result.error.message)),
		),
	);

/**
 * Queues the check of an upload. Never fails the upload: if the engine can't be reached
 * the photo stays `pending` and the engine's cron queues it again (STALE_PENDING_AFTER).
 */
export const requestPhotoCheck = (engine: PhotoRpc, imageId: string) =>
	call(() => engine.requestPhotoVerification({ imageId })).pipe(
		Effect.as(true),
		Effect.tapError((error) =>
			Effect.logWarning("photo check not queued; the engine cron will retry").pipe(
				Effect.annotateLogs({ image_id: imageId, error: error.message }),
			),
		),
		Effect.orElseSucceed(() => false),
	);

/** An admin's decision on a held photo; false when it wasn't in review any more. */
export const reviewHeldPhoto = (
	engine: PhotoRpc,
	input: { imageId: string; adminId: string; decision: "approved" | "rejected" },
) => call(() => engine.reviewPhoto(input));
