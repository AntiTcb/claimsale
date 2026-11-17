/**
 * Photo authenticity at publish time (PLAN §3 "Photo authenticity", D63, D66). Pure:
 * the caller (the web publish path today, the engine's publish RPC from WS-E) loads the
 * photo statuses and the seller's completed-sale count and asks these functions.
 *
 * The duplicate decision itself (distances, IMG-dup-reject / -review / own reuse) lives
 * with the hashes in `@claimsale/imagehash` (decision.ts).
 */
import { ok, reject, type Rejection, type Result } from "./common.ts";

export const PHOTO_STATUSES = ["pending", "approved", "review", "rejected"] as const;
export type PhotoStatus = (typeof PHOTO_STATUSES)[number];

/** D66: sellers with fewer completed sales than this need a timestamp photo on every sale. */
export const TIMESTAMP_EXEMPT_COMPLETED_SALES = 5;

/** D66 "completed sales": sales that ran and closed (owner to confirm; see WS-F2 notes). */
export const COMPLETED_SALE_STATUSES = ["closed", "archived"] as const;

/**
 * PLAN "Repeat offenders": an account is flagged for admin review once this many of its
 * photos were rejected as another seller's image ("several"; tune with real data).
 */
export const REPEAT_OFFENDER_REJECTIONS = 3;

export type PhotoPublishRejection = Rejection<
	| "missing_photos"
	| "photos_pending"
	| "photos_in_review"
	| "timestamp_required"
	| "timestamp_pending"
	| "timestamp_in_review"
>;

export interface PublishPhotoState {
	/** Every item of the sale, with the statuses of its photos (any order). */
	readonly items: ReadonlyArray<{ readonly photos: ReadonlyArray<PhotoStatus> }>;
	/** The sale's current timestamp photo, if any. */
	readonly timestamp: PhotoStatus | null;
	/** The seller's completed sales (`countsAsCompletedSale`). */
	readonly completedSales: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** D66: whether this seller must add a timestamp photo before publishing. */
export function needsTimestampPhoto(completedSales: number): boolean {
	return completedSales < TIMESTAMP_EXEMPT_COMPLETED_SALES;
}

/**
 * D66 "Timestamped" badge: shown when the sale has an approved timestamp photo.
 *
 * @spec IMG-timestamp-required
 */
export function isTimestamped(timestamp: PhotoStatus | null): boolean {
	return timestamp === "approved";
}

/**
 * Whether a sale may be scheduled or published as far as its photos go. Items are
 * checked first (the most common gap), then the timestamp photo.
 *
 * @spec IMG-required — every item needs at least one `approved` photo; a pending or
 *   held photo doesn't count, and the message says which it is.
 * @spec IMG-dup-review — a photo held for review blocks publishing until it is resolved.
 * @spec IMG-timestamp-required — sellers with fewer than 5 completed sales need an
 *   approved timestamp photo for this sale.
 */
export function checkPublishPhotos(state: PublishPhotoState): Result<true, PhotoPublishRejection> {
	const unapproved = state.items.filter((item) => !item.photos.includes("approved"));
	if (unapproved.length > 0) {
		const missing = unapproved.filter(
			(item) => !item.photos.some((s) => s === "pending" || s === "review"),
		).length;
		if (missing > 0) {
			return reject("missing_photos", "Add at least one photo to every item before publishing");
		}
		const pending = unapproved.filter((item) => item.photos.includes("pending")).length;
		if (pending > 0) {
			return reject(
				"photos_pending",
				`We're still checking the photos of ${plural(pending, "item", "items")}. Try again in a minute.`,
			);
		}
		return reject(
			"photos_in_review",
			`The photos of ${plural(unapproved.length, "item are", "items are")} held for review. Replace them or wait for a decision.`,
		);
	}
	if (needsTimestampPhoto(state.completedSales)) {
		if (state.timestamp === null || state.timestamp === "rejected") {
			return reject(
				"timestamp_required",
				"Add a timestamp photo: your cards beside a note with your handle and today's date",
			);
		}
		if (state.timestamp === "pending") {
			return reject("timestamp_pending", "We're still checking your timestamp photo. Try again in a minute.");
		}
		if (state.timestamp === "review") {
			return reject(
				"timestamp_in_review",
				"Your timestamp photo is held for review. Replace it or wait for a decision.",
			);
		}
	}
	return ok(true);
}

/**
 * The flag threshold for repeat offenders.
 *
 * @spec IMG-repeat-offender
 */
export function isRepeatOffender(rejectedMatches: number): boolean {
	return rejectedMatches >= REPEAT_OFFENDER_REJECTIONS;
}
