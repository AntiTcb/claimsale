import type { Millis, UserId } from "./common.ts";
import {
	compareRank,
	deriveItemState,
	freeUnits,
	unitsHeld,
	type EndedReason,
	type EntryKind,
	type EntryStatus,
	type Item,
	type ItemState,
} from "./item.ts";
import type { Cents } from "./money.ts";
import type { SaleStatus } from "./sale.ts";
import { entryCounts, visibleOffers, type OfferVisibility } from "./visibility.ts";

/**
 * The live grid's projection of an item (PLAN §5 "Realtime details", WS-H): what one
 * viewer may see of it, computed from the full item. The engine sends it over the
 * sale's WebSocket after every commit and in the snapshot on connect, and the web
 * Worker renders it on page load, so every path goes through this one function.
 *
 * Nothing here names another buyer: no buyer IDs, no handles. Offer amounts follow the
 * sale's offer visibility, the hidden minimum offer never appears, and items carry no
 * market price at all.
 */

/** Who is looking: the sale's seller, a signed-in buyer, or a signed-out visitor. */
export type LiveViewer =
	| { readonly kind: "seller" }
	| { readonly kind: "buyer"; readonly id: UserId }
	| { readonly kind: "visitor" };

/**
 * Where one of the viewer's own entries stands.
 * - `won`: holds a unit; `rank` is its place among the winners (PLAN §3: positions
 *   1..quantity are winners), so a single-copy winner is "#1".
 * - `waiting`: open while units are free (the seller is deciding); `rank` in the queue.
 * - `backup`: open on a sold-out item; `rank` among the backups ("backup #2").
 * - `countered`: the seller countered an offer and waits for the buyer's answer.
 * - `ended`: a terminal status (declined, lost, rescinded, …).
 */
export type EntryPosition =
	| { readonly kind: "won"; readonly rank: number }
	| { readonly kind: "waiting"; readonly rank: number }
	| { readonly kind: "backup"; readonly rank: number }
	| { readonly kind: "countered" }
	| { readonly kind: "ended" };

export interface MyEntry {
	readonly id: string;
	readonly kind: EntryKind;
	readonly status: EntryStatus;
	readonly amountCents: Cents;
	readonly counterCents: Cents | null;
	readonly counterExpiresAt: Millis | null;
	readonly endedReason: EndedReason | null;
	readonly position: EntryPosition;
}

export interface LiveOffer {
	/** "Buyer A", "Buyer B", … (anonymous). */
	readonly label: string;
	readonly amountCents: Cents;
}

export interface LiveItem {
	readonly id: string;
	/** The item row's version after the commit: clients keep the highest they've seen. */
	readonly version: number;
	readonly state: ItemState;
	readonly quantity: number;
	readonly freeUnits: number;
	readonly unitsWon: number;
	/** Pending claims and offers (SM-3-counts-public). */
	readonly claimCount: number;
	readonly offerCount: number;
	readonly decisionDeadline: Millis | null;
	/** Offer amounts this viewer may see (SM-3-offer-visibility); empty in blind mode. */
	readonly offers: readonly LiveOffer[];
	/** The viewer's own entries on the item, oldest first; empty for visitors and the seller. */
	readonly mine: readonly MyEntry[];
}

const holdsUnit = (status: EntryStatus) => status === "won" || status === "fulfilled";

function positionOf(item: Item, entryId: string, status: EntryStatus): EntryPosition {
	if (holdsUnit(status)) {
		const winners = item.entries
			.filter((e) => holdsUnit(e.status))
			.toSorted((a, b) => (a.wonAt ?? 0) - (b.wonAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return { kind: "won", rank: winners.findIndex((e) => e.id === entryId) + 1 };
	}
	if (status === "countered") return { kind: "countered" };
	if (status === "open") {
		const queue = item.entries.filter((e) => e.status === "open").toSorted(compareRank);
		const rank = queue.findIndex((e) => e.id === entryId) + 1;
		return freeUnits(item) > 0 ? { kind: "waiting", rank } : { kind: "backup", rank };
	}
	return { kind: "ended" };
}

/**
 * The item as `viewer` may see it.
 *
 * @spec SM-3-counts-public — claim and offer counts go to every viewer.
 * @spec SM-3-offer-visibility — amounts only in `visible` mode (or to the seller), with anonymous labels.
 * @spec LIVE-no-leak — no other buyer's identity, no hidden minimum, no market price.
 */
export function liveItem(
	item: Item,
	version: number,
	saleStatus: SaleStatus,
	visibility: OfferVisibility,
	viewer: LiveViewer,
): LiveItem {
	const counts = entryCounts(item);
	const offers = visibleOffers(item, visibility, viewer.kind === "seller" ? "seller" : "public").map((o) => ({
		label: o.label,
		amountCents: o.amountCents,
	}));
	const mine =
		viewer.kind === "buyer"
			? item.entries
					.filter((e) => e.buyerId === viewer.id)
					.toSorted((a, b) => a.createdAt - b.createdAt)
					.map((e): MyEntry => ({
						id: e.id,
						kind: e.kind,
						status: e.status,
						amountCents: e.amountCents,
						counterCents: e.counterCents,
						counterExpiresAt: e.counterExpiresAt,
						endedReason: e.endedReason,
						position: positionOf(item, e.id, e.status),
					}))
			: [];
	return {
		id: item.id,
		version,
		state: deriveItemState(item, saleStatus),
		quantity: item.quantity,
		freeUnits: freeUnits(item),
		unitsWon: unitsHeld(item),
		claimCount: counts.claims,
		offerCount: counts.offers,
		decisionDeadline: item.decisionDeadline,
		offers,
		mine,
	};
}

/**
 * The buyer's running total in one sale: everything they hold a unit of.
 *
 * @spec LIVE-running-total — the sum of the buyer's won entries (D53), in integer cents.
 */
export function runningTotal(items: Iterable<Pick<LiveItem, "mine">>): { cents: Cents; count: number } {
	let cents = 0;
	let count = 0;
	for (const item of items) {
		for (const entry of item.mine) {
			if (holdsUnit(entry.status)) {
				cents += entry.amountCents;
				count += 1;
			}
		}
	}
	return { cents, count };
}

// ---------------------------------------------------------------------------
// The live socket's protocol (engine → browser). One JSON object per frame; the
// browser only ever sends "ping", which the engine answers with "pong" without waking.

export const LIVE_PROTOCOL = 1;
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";
/** Close codes: the viewer may no longer see the sale (it went back to draft), or it's gone. */
export const LIVE_CLOSE_NOT_VISIBLE = 4403;
export const LIVE_CLOSE_NOT_FOUND = 4404;
/**
 * Web Worker → engine only: the signed-in user on a forwarded socket upgrade. The engine
 * has no public route, so only the web Worker (which checked the session) can set it.
 */
export const LIVE_VIEWER_HEADER = "x-claimsale-viewer";

/** The sale's status as of `at` (server ms): clients keep the newest `at`. */
export interface LiveSale {
	readonly status: SaleStatus;
	readonly liveAt: Millis | null;
	readonly closesAt: Millis | null;
	readonly at: Millis;
}

export interface LiveSnapshot {
	readonly serverNow: Millis;
	readonly sale: LiveSale;
	readonly items: readonly LiveItem[];
}

export type LiveMessage =
	/** First frame on every connect: the server's clock, for countdowns (PLAN §5). */
	| { readonly type: "hello"; readonly protocol: typeof LIVE_PROTOCOL; readonly serverNow: Millis }
	/**
	 * Every item as this viewer may see it; sent on every (re)connect, and with
	 * `edited: true` after the seller changed items outside a command (the item editor, an
	 * import), when the page's titles, prices and photos may be stale too.
	 */
	| ({ readonly type: "snapshot"; readonly edited?: true } & LiveSnapshot)
	/** The sale changed status (go-live, close, unpublish). */
	| { readonly type: "sale"; readonly sale: LiveSale }
	/** Items one commit changed, as this viewer may see them. */
	| { readonly type: "items"; readonly items: readonly LiveItem[] };
