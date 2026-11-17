/**
 * The duplicate decision (PLAN "Photo authenticity", step 4; D65). Pure: the caller
 * (the engine's verify job, WS-F2) finds other sellers' candidate images, measures each
 * with `matchDistance`, and passes the distances here.
 */
import type { MatchDistance } from "./image.ts";

/** Reject when the closest match is within this distance on both hashes (D65). */
export const REJECT_MAX_DISTANCE = 6;
/** Hold for admin review when it is within this distance on both hashes (D65: 7–12). */
export const REVIEW_MAX_DISTANCE = 12;

export type PhotoDecision = "approved" | "review" | "rejected";

/**
 * Decides an upload from its distances to other sellers' images (own images are
 * excluded by the caller; IMG-own-reuse is a separate rule).
 *
 * A match counts at a level only when both hashes agree, so a coincidental near match
 * on one hash alone does not trigger it. The most severe match wins.
 *
 * @spec IMG-dup-reject
 * @spec IMG-dup-review
 */
export function decidePhoto(otherSellerMatches: readonly MatchDistance[]): PhotoDecision {
	let decision: PhotoDecision = "approved";
	for (const m of otherSellerMatches) {
		const worst = Math.max(m.dhash, m.phash);
		if (worst <= REJECT_MAX_DISTANCE) return "rejected";
		if (worst <= REVIEW_MAX_DISTANCE) decision = "review";
	}
	return decision;
}

/**
 * Where an upload or a stored image belongs. `itemId` null is a sale's timestamp photo
 * (D66).
 */
export interface PhotoPlace {
	readonly sellerId: string;
	readonly saleId: string;
	readonly itemId: string | null;
}

/** A stored image found by the band lookup, with its distance to the upload. */
export interface StoredMatch extends PhotoPlace {
	readonly imageId: string;
	/**
	 * The stored image is still in use (not deleted, not rejected). Another seller's
	 * images count either way ("past or present"); one's own only while in use.
	 */
	readonly inUse: boolean;
	readonly distance: MatchDistance;
}

/** Why a photo was rejected or held. Shown to admins only, never to the seller. */
export type PhotoReason = "duplicate" | "possible_duplicate" | "own_reuse" | "timestamp_reuse";

export interface PhotoVerdict {
	readonly decision: PhotoDecision;
	readonly reason: PhotoReason | null;
	/** The deciding match (admin review only; IMG-dup-reject never shows it to the seller). */
	readonly match: { readonly imageId: string; readonly distance: number } | null;
}

/** The larger of the two distances: a match is only as close as its farther hash. */
const closeness = (m: StoredMatch) => Math.max(m.distance.dhash, m.distance.phash);

const closest = (matches: readonly StoredMatch[]) =>
	matches.reduce<StoredMatch | undefined>(
		(best, m) => (best === undefined || closeness(m) < closeness(best) ? m : best),
		undefined,
	);

const verdict = (decision: PhotoDecision, reason: PhotoReason | null, match?: StoredMatch): PhotoVerdict => ({
	decision,
	reason,
	match: match ? { imageId: match.imageId, distance: closeness(match) } : null,
});

/**
 * The full verdict for an upload, from the stored images the band lookup found:
 *
 * 1. Another seller's image within the reject distance → rejected (`duplicate`).
 * 2. Own reuse within the reject distance → rejected when it is
 *    - an item photo already used for a *different* item of the same sale (`own_reuse`;
 *      reusing a photo for the same item, or relisting in another sale, is allowed), or
 *    - a timestamp photo whose image was already used in another sale
 *      (`timestamp_reuse`: D66 needs a new one for each sale, even your own).
 * 3. Another seller's image in the review band → held for review (`possible_duplicate`).
 * 4. Otherwise approved.
 *
 * @spec IMG-dup-reject
 * @spec IMG-dup-review
 * @spec IMG-own-reuse
 * @spec IMG-timestamp-required — an old timestamp photo can't be reused.
 */
export function decideUpload(upload: PhotoPlace, matches: readonly StoredMatch[]): PhotoVerdict {
	const others = matches.filter((m) => m.sellerId !== upload.sellerId);
	const decision = decidePhoto(others.map((m) => m.distance));
	const within = (max: number) => (m: StoredMatch) => closeness(m) <= max;
	if (decision === "rejected") {
		return verdict("rejected", "duplicate", closest(others.filter(within(REJECT_MAX_DISTANCE))));
	}
	const own = matches.filter((m) => m.sellerId === upload.sellerId && closeness(m) <= REJECT_MAX_DISTANCE);
	const reused =
		upload.itemId === null
			? closest(own.filter((m) => m.saleId !== upload.saleId))
			: closest(
					own.filter(
						(m) => m.inUse && m.saleId === upload.saleId && m.itemId !== null && m.itemId !== upload.itemId,
					),
				);
	if (reused) return verdict("rejected", upload.itemId === null ? "timestamp_reuse" : "own_reuse", reused);
	if (decision === "review") {
		return verdict("review", "possible_duplicate", closest(others.filter(within(REVIEW_MAX_DISTANCE))));
	}
	return verdict("approved", null);
}
