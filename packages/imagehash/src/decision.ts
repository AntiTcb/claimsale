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
