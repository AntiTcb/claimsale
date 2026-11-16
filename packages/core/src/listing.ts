import { ok, reject, type Rejection, type Result, type Tier, type UserId } from "./common.ts";
import type { SaleStatus } from "./sale.ts";

/**
 * Who can see a sale and its photos, and what a seller may list (PLAN §3 "Sale",
 * D5, D31, D33, D56). Pure, so the web Worker, the engine and the tests agree.
 */

export type SaleVisibility = "public" | "unlisted" | "private";

/** Photos per item (D33). */
export const FREE_PHOTO_CAP = 4;
export const PRO_PHOTO_CAP = 12;

/**
 * @spec SM-2-photo-cap — free sellers get 4 photos per item, Pro sellers 12.
 */
export function photoCap(sellerTier: Tier): number {
	return sellerTier === "pro" ? PRO_PHOTO_CAP : FREE_PHOTO_CAP;
}

/** @spec SM-2-photo-cap */
export function canAddPhoto(
	sellerTier: Tier,
	photoCount: number,
): Result<true, Rejection<"photo_cap_reached">> {
	const cap = photoCap(sellerTier);
	return photoCount >= cap
		? reject(
				"photo_cap_reached",
				`${sellerTier === "pro" ? "Pro" : "Free"} sellers can add ${cap} photos per item`,
			)
		: ok(true);
}

/**
 * Whether the seller may give a sale this visibility.
 *
 * @spec SM-2-private-pro — private sales (password or allowlist) are Pro only; unlisted is free (D31).
 */
export function canUseVisibility(
	sellerTier: Tier,
	visibility: SaleVisibility,
): Result<true, Rejection<"pro_only">> {
	if (visibility === "private" && sellerTier !== "pro") {
		return reject(
			"pro_only",
			"Private sales (password or invite list) are a Pro feature. Use unlisted instead.",
		);
	}
	return ok(true);
}

export interface SaleGate {
	readonly sellerId: UserId;
	readonly status: SaleStatus;
	readonly visibility: SaleVisibility;
	/** Private sales only: which methods the seller turned on. */
	readonly hasPassword: boolean;
	readonly allowlistEnabled: boolean;
}

export interface Viewer {
	/** Null when signed out. */
	readonly userId: UserId | null;
	/** True when this browser unlocked the sale with its password. */
	readonly passwordUnlocked: boolean;
	/** True when the viewer's *verified* email is on the sale's allowlist. */
	readonly allowlisted: boolean;
}

/**
 * - `ok`: show the sale.
 * - `locked`: a private sale; show only the title, seller and the unlock options.
 * - `not_found`: answer exactly as if the sale didn't exist.
 */
export type SaleAccess = "ok" | "locked" | "not_found";

/**
 * Whether a viewer can see a sale and its items and photos.
 *
 * @spec SM-2-visibility — drafts (and deleted sales) are seen only by their seller;
 * public and unlisted sales by anyone with the link; private sales by the seller,
 * a browser that entered the password, or a signed-in user whose verified email
 * is on the allowlist (D5).
 */
export function saleAccess(sale: SaleGate, viewer: Viewer): SaleAccess {
	const isSeller = viewer.userId !== null && viewer.userId === sale.sellerId;
	if (sale.status === "deleted") return "not_found";
	if (isSeller) return "ok";
	if (sale.status === "draft") return "not_found";
	if (sale.visibility !== "private") return "ok";
	if (sale.hasPassword && viewer.passwordUnlocked) return "ok";
	if (sale.allowlistEnabled && viewer.allowlisted) return "ok";
	return "locked";
}

/**
 * Whether the sale belongs in browse, search and sitemaps, and may be indexed.
 *
 * @spec SM-2-visibility — only public sales are listed or indexed; unlisted and
 * private sales are `noindex` (D5, D56).
 */
export function isListed(sale: Pick<SaleGate, "status" | "visibility">): boolean {
	return sale.visibility === "public" && sale.status !== "draft" && sale.status !== "deleted";
}

/**
 * How a sale's photos may be cached once access is granted.
 *
 * @spec SM-2-private-images — photos of private sales and drafts are never publicly
 * cacheable, so a guessed or shared URL can't serve them past the access check.
 */
export function imageCacheControl(sale: Pick<SaleGate, "status" | "visibility">): string {
	return sale.visibility === "private" || sale.status === "draft"
		? "private, no-store"
		: "public, max-age=3600";
}
