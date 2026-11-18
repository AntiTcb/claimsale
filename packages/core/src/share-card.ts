import { formatCents, type Cents } from "./money.ts";

/**
 * Share cards (milestone 10, WS-L2, TECH_STACK S13): the Open Graph image and text a
 * sale link shows when it's posted in a Facebook group. Pure rules here; the web Worker
 * renders the image and caches it in R2.
 *
 * A card never depends on who is looking: it's what a signed-out visitor may see, because
 * crawlers fetch it without cookies and everyone in the group sees the same preview.
 */

/** Items listed on a full card; the rest are counted. */
export const SHARE_CARD_ITEMS = 3;
const MAX_TITLE = 90;
const MAX_ITEM_TITLE = 48;

export type ShareCardStatus = "upcoming" | "live" | "closed";

export const SHARE_CARD_STATUS_LABELS: Record<ShareCardStatus, string> = {
	upcoming: "Upcoming",
	live: "Live now",
	closed: "Closed",
};

export interface ShareCardSale {
	readonly title: string;
	readonly sellerHandle: string | null;
	readonly sellerDisplayName: string | null;
	readonly status: string;
	/** What a signed-out visitor gets (`saleAccess`): `ok` for public and unlisted, `locked` for private. */
	readonly access: "ok" | "locked";
}

export interface ShareCardItem {
	readonly title: string;
	readonly priceCents: Cents;
	readonly quantity: number;
	readonly unitsWon: number;
	readonly state: string;
}

export interface ShareCard {
	readonly title: string;
	/** "Misty (@misty)", or "@misty" without a display name. */
	readonly seller: string;
	readonly status: ShareCardStatus;
	/** A private sale's card: title and seller only. */
	readonly private: boolean;
	readonly itemCount: number;
	readonly items: readonly { readonly title: string; readonly price: string; readonly soldOut: boolean }[];
	/** Listed items not on the card. */
	readonly more: number;
}

function clip(text: string, max: number): string {
	const t = text.trim().replace(/\s+/g, " ");
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function cardStatus(status: string): ShareCardStatus {
	if (status === "live") return "live";
	if (status === "closed" || status === "archived") return "closed";
	return "upcoming";
}

/**
 * The share card for a sale.
 *
 * @spec SHARE-private-title-only — a private sale's card shows only its title, seller and
 * status: no items, prices or counts (PLAN §3 visibility), whoever is looking.
 */
export function shareCard(sale: ShareCardSale, items: readonly ShareCardItem[]): ShareCard {
	const name = sale.sellerDisplayName?.trim() || null;
	const handle = sale.sellerHandle ? `@${sale.sellerHandle}` : null;
	const seller = name && handle ? `${name} (${handle})` : (handle ?? name ?? "a seller");
	const base = { title: clip(sale.title, MAX_TITLE), seller, status: cardStatus(sale.status) };
	if (sale.access === "locked") return { ...base, private: true, itemCount: 0, items: [], more: 0 };
	const listed = items.filter((i) => i.state !== "withdrawn");
	// Available items first, so the card shows what can still be claimed.
	const soldOut = (i: ShareCardItem) => i.unitsWon >= i.quantity;
	const shown = [...listed.filter((i) => !soldOut(i)), ...listed.filter(soldOut)].slice(0, SHARE_CARD_ITEMS);
	return {
		...base,
		private: false,
		itemCount: listed.length,
		items: shown.map((i) => ({
			title: clip(i.title, MAX_ITEM_TITLE),
			price: formatCents(i.priceCents),
			soldOut: soldOut(i),
		})),
		more: listed.length - shown.length,
	};
}

/**
 * A short version tag for a card: it changes whenever anything on the card does, so the
 * cached image and the `og:image` URL change with it (FNV-1a over the card's fields).
 *
 * @spec SHARE-cache-version — the image is cached per card version; editing what the card
 * shows gives a new version and a new image URL, and the same card always the same one.
 */
export function shareCardVersion(card: ShareCard): string {
	const text = JSON.stringify([
		card.title,
		card.seller,
		card.status,
		card.private,
		card.itemCount,
		card.items.map((i) => [i.title, i.price, i.soldOut]),
		card.more,
	]);
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/** The `og:description` text: the same facts as the image. */
export function shareCardDescription(card: ShareCard): string {
	const status = SHARE_CARD_STATUS_LABELS[card.status];
	if (card.private) return `A private sale by ${card.seller} on ClaimSale. ${status}.`;
	const count = `${card.itemCount} ${card.itemCount === 1 ? "item" : "items"}`;
	return `${count} from ${card.seller}. ${status}. Claim on ClaimSale.`;
}
