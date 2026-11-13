import type { UserId } from "./common.ts";
import type { Item } from "./item.ts";
import type { Cents } from "./money.ts";

/** What buyers see of an item's entries (STATE_MACHINES §3, D26, D47). */

export type OfferVisibility = "blind" | "visible";

export interface EntryCounts {
	readonly claims: number;
	readonly offers: number;
}

/**
 * Counts of pending claims and offers.
 *
 * @spec SM-3-counts-public — always visible, whatever the offer visibility.
 */
export function entryCounts(item: Item): EntryCounts {
	let claims = 0;
	let offers = 0;
	for (const entry of item.entries) {
		if (entry.status !== "open" && entry.status !== "countered") continue;
		if (entry.kind === "claim") claims += 1;
		else offers += 1;
	}
	return { claims, offers };
}

export interface VisibleOffer {
	/** "Buyer A", "Buyer B", … in order of each buyer's first entry on the item. */
	readonly label: string;
	readonly amountCents: Cents;
	/** Only for the seller. */
	readonly buyerId?: UserId;
}

function label(index: number): string {
	let n = index;
	let out = "";
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return `Buyer ${out}`;
}

/**
 * The pending offers a viewer may see.
 *
 * @spec SM-3-offer-visibility — `blind`: only the seller sees amounts. `visible`: everyone
 * sees amounts with anonymous labels; the seller also sees who made them.
 */
export function visibleOffers(
	item: Item,
	visibility: OfferVisibility,
	viewer: "seller" | "public",
): VisibleOffer[] {
	if (visibility === "blind" && viewer !== "seller") return [];
	const order = new Map<UserId, number>();
	for (const entry of item.entries.toSorted((a, b) => a.createdAt - b.createdAt)) {
		if (!order.has(entry.buyerId)) order.set(entry.buyerId, order.size);
	}
	return item.entries
		.filter((e) => e.kind === "offer" && (e.status === "open" || e.status === "countered"))
		.toSorted((a, b) => b.amountCents - a.amountCents || a.createdAt - b.createdAt)
		.map((e) => ({
			label: label(order.get(e.buyerId) ?? 0),
			amountCents: e.amountCents,
			...(viewer === "seller" ? { buyerId: e.buyerId } : {}),
		}));
}
