import {
	saleAccess,
	shareCard,
	shareCardDescription,
	shareCardVersion,
	type ShareCard,
} from "@claimsale/core";
import type { Db } from "@claimsale/db";
import type { ItemRow } from "./items.ts";
import { listItems } from "./items.ts";
import { findSaleBySlug, type PublicSale } from "./sales.ts";

/**
 * Share cards for sale links (WS-L2, TECH_STACK S13). The card is what a signed-out
 * visitor may see (crawlers fetch it without cookies), whoever asks for it.
 */

/**
 * Bump when `ShareCardImage.svelte` changes how a card looks: it's part of every cached
 * image's key and `og:image` URL, so old renders aren't served for the new design.
 */
export const SHARE_IMAGE_DESIGN = 3;

const SIGNED_OUT = { userId: null, passwordUnlocked: false, allowlisted: false } as const;

/** What a signed-out visitor gets of this sale, or null when they'd get a 404. */
function anonymousAccess(sale: PublicSale): "ok" | "locked" | null {
	const access = saleAccess(sale, SIGNED_OUT);
	return access === "not_found" ? null : access;
}

/**
 * The card for a sale whose items the caller already has. `items` is only read when a
 * signed-out visitor could see them.
 */
export function shareCardFor(sale: PublicSale, items: readonly ItemRow[]): ShareCard | null {
	const access = anonymousAccess(sale);
	if (access === null) return null;
	return shareCard(
		{
			title: sale.title,
			sellerHandle: sale.sellerHandle,
			sellerDisplayName: sale.sellerDisplayName,
			status: sale.status,
			access,
		},
		access === "ok" ? items : [],
	);
}

/** Loads a sale's card by slug; null for drafts, deleted and missing sales. */
export async function loadShareCard(
	db: Db,
	slug: string,
): Promise<{ saleId: string; card: ShareCard; version: string } | null> {
	const sale = await findSaleBySlug(db, slug);
	if (!sale) return null;
	const access = anonymousAccess(sale);
	if (access === null) return null;
	const card = shareCardFor(sale, access === "ok" ? await listItems(db, sale.id) : []);
	if (!card) return null;
	return { saleId: sale.id, card, version: shareImageVersion(card) };
}

/** The card's version plus the design's: what the cache key and `og:image` URL carry. */
export function shareImageVersion(card: ShareCard): string {
	return `${SHARE_IMAGE_DESIGN}-${shareCardVersion(card)}`;
}

/** Where a card version's PNG is cached in the IMAGES bucket. */
export function shareImagePrefix(saleId: string): string {
	return `og/sales/${saleId}/`;
}

export function shareImageKey(saleId: string, version: string): string {
	return `${shareImagePrefix(saleId)}${version}.png`;
}

/** The `og:image` path; the version makes Facebook fetch a new image when the card changes. */
export function shareImagePath(slug: string, version: string): string {
	return `/og/s/${encodeURIComponent(slug)}.png?v=${version}`;
}

/** What the sale page puts in its `og:` and `twitter:` tags; null for drafts. */
export interface ShareMeta {
	readonly title: string;
	readonly description: string;
	/** Absolute, versioned image URL. */
	readonly image: string;
	readonly url: string;
}

export function shareMeta(sale: PublicSale, items: readonly ItemRow[], origin: string): ShareMeta | null {
	const card = shareCardFor(sale, items);
	if (!card) return null;
	return {
		title: card.title,
		description: shareCardDescription(card),
		image: `${origin}${shareImagePath(sale.slug, shareImageVersion(card))}`,
		url: `${origin}/s/${encodeURIComponent(sale.slug)}`,
	};
}

/** The parts of an R2 bucket the cache uses, so tests can pass a fake. */
export type ShareImageBucket = Pick<R2Bucket, "get" | "put" | "list" | "delete">;

/**
 * The cached PNG for this card version, rendering and storing it on a miss. Older versions
 * of the sale's card are deleted once the new one is stored.
 *
 * @spec SHARE-cache-version
 */
export async function cachedShareImage(
	bucket: ShareImageBucket,
	saleId: string,
	version: string,
	render: () => Promise<ArrayBuffer>,
): Promise<{ body: ReadableStream | ArrayBuffer; cached: boolean }> {
	const key = shareImageKey(saleId, version);
	const hit = await bucket.get(key);
	if (hit) return { body: hit.body, cached: true };
	const png = await render();
	await bucket.put(key, png, { httpMetadata: { contentType: "image/png" } });
	const old = await bucket.list({ prefix: shareImagePrefix(saleId) });
	const stale = old.objects.map((o) => o.key).filter((k) => k !== key);
	if (stale.length > 0) await bucket.delete(stale);
	return { body: png, cached: false };
}
