/**
 * The photo verify job (PLAN §3 "Photo authenticity", steps 2–5; TECH_STACK S33): a
 * `pending` upload is decoded, hashed (5 variants × dHash + pHash), looked up in the
 * band index, decided and recorded.
 */
import { type Decoder } from "@claimsale/imagehash/decode";
import { candidateBands, decideUpload, hashImage, type PhotoVerdict } from "@claimsale/imagehash";
import { Clock, Data, Effect, Option } from "effect";
import { findMatches, flagIfRepeatOffender, loadPhoto, rejectUnreadable, saveVerdict } from "./store.ts";

export interface VerifyDeps {
	readonly db: D1Database;
	readonly images: Pick<R2Bucket, "get">;
	readonly decode: Decoder;
}

export class PhotoStoreError extends Data.TaggedError("PhotoStoreError")<{ readonly cause: unknown }> {
	override get message() {
		return `photo R2 read failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
	}
}

/** Band lookup radius: radius 1 finds every match within 7 bits (all rejects). */
export const LOOKUP_RADIUS = 1;

export type VerifyOutcome =
	| { readonly kind: "skipped"; readonly why: "missing" | "already_decided" }
	| { readonly kind: "unreadable" }
	| { readonly kind: "decided"; readonly verdict: PhotoVerdict; readonly flagged: boolean };

const readObject = (images: VerifyDeps["images"], key: string) =>
	Effect.tryPromise({
		try: async () => {
			const object = await images.get(key);
			return object ? new Uint8Array(await object.arrayBuffer()) : undefined;
		},
		catch: (cause) => new PhotoStoreError({ cause }),
	});

/**
 * Verifies one photo. Idempotent: a photo that is gone or no longer `pending` is
 * skipped, so a redelivered message does nothing. D1 and R2 failures fail the Effect
 * (the queue retries); an undecodable image is rejected.
 *
 * @spec IMG-dup-reject — the seller only ever sees `rejected`; the match is recorded for admins.
 * @spec IMG-dup-review
 * @spec IMG-own-reuse
 * @spec IMG-repeat-offender
 */
export const verifyPhoto = (deps: VerifyDeps, imageId: string) =>
	Effect.gen(function* () {
		const photo = yield* loadPhoto(deps.db, imageId);
		if (!photo) return { kind: "skipped", why: "missing" } as const;
		if (photo.status !== "pending") return { kind: "skipped", why: "already_decided" } as const;
		const now = yield* Clock.currentTimeMillis;
		const bytes = yield* readObject(deps.images, photo.r2_key);
		const decoded = bytes ? yield* Effect.option(Effect.tryPromise(() => deps.decode(bytes))) : Option.none();
		if (Option.isNone(decoded)) {
			yield* rejectUnreadable(deps.db, photo, now);
			yield* Effect.logWarning("photo could not be decoded; rejected");
			return { kind: "unreadable" } as const;
		}
		const hashes = hashImage(decoded.value);
		const matches = yield* findMatches(deps.db, photo.id, hashes, candidateBands(hashes, LOOKUP_RADIUS));
		const verdict = decideUpload(
			{ sellerId: photo.seller_id, saleId: photo.sale_id, itemId: photo.item_id },
			matches,
		);
		yield* saveVerdict(deps.db, photo, hashes, verdict, now);
		const flagged =
			verdict.decision === "rejected" && verdict.reason === "duplicate"
				? yield* flagIfRepeatOffender(deps.db, photo.seller_id, now)
				: false;
		yield* Effect.logInfo("photo verified").pipe(
			Effect.annotateLogs({
				decision: verdict.decision,
				reason: verdict.reason ?? "none",
				candidates: matches.length,
				flagged,
			}),
		);
		return { kind: "decided", verdict, flagged } as const;
	}).pipe(
		Effect.annotateLogs({ image_id: imageId }),
		Effect.withSpan("engine.photos.verify", { attributes: { image_id: imageId } }),
	);
