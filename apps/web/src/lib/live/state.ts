import { formatCents, type LiveItem, type LiveSale, type MyEntry } from "@claimsale/core";

/**
 * The browser's side of the live grid (WS-H), pure so it can be unit-tested: merging
 * what the socket sends, the buyer's position labels, the announcements read out to
 * screen readers, and the grid filters.
 */

export type LiveItems = Readonly<Record<string, LiveItem>>;

/**
 * Keeps each item's highest version. A diff can arrive before the snapshot that a
 * reconnect sends (the engine accepts the socket first), so older data never wins.
 *
 * @spec LIVE-broadcast — clients ignore versions they already have.
 */
export function mergeItems(
	current: LiveItems,
	incoming: readonly LiveItem[],
): { items: LiveItems; changed: LiveItem[]; unknown: string[] } {
	const next: Record<string, LiveItem> = { ...current };
	const changed: LiveItem[] = [];
	const unknown: string[] = [];
	for (const item of incoming) {
		const known = next[item.id];
		if (!known) unknown.push(item.id);
		if (known && known.version >= item.version) continue;
		next[item.id] = item;
		changed.push(item);
	}
	return { items: changed.length === 0 ? current : next, changed, unknown };
}

/** The newer of two sale states (by the server's `at`). */
export function mergeSale(current: LiveSale | null, incoming: LiveSale): LiveSale {
	return current && current.at > incoming.at ? current : incoming;
}

/** The entry that speaks for the buyer on this item: the latest one, preferring a pending or won one. */
export function currentEntry(item: Pick<LiveItem, "mine"> | undefined): MyEntry | undefined {
	const mine = item?.mine ?? [];
	return mine.findLast((e) => e.position.kind !== "ended") ?? mine.at(-1);
}

const ENDED: Partial<Record<NonNullable<MyEntry["endedReason"]>, string>> = {
	seller_declined: "Offer declined",
	below_minimum: "Offer not accepted",
	counter_declined: "Counter declined",
	counter_expired: "Counter expired",
	offer_lapsed: "Offer lapsed",
	buyer_withdrew: "Offer withdrawn",
	left_backup_queue: "Left the queue",
	units_paid: "Went to another buyer",
	item_withdrawn: "Item withdrawn",
	sale_cancelled: "Sale cancelled",
	seller_rescind: "Rescinded by the seller",
	buyer_rescind: "You rescinded",
	takeback: "Taken back",
	invoice_completed: "Completed",
};

/**
 * The short badge for the buyer's own entry ("You're #1", "Backup #2").
 *
 * @spec LIVE-position — winners are #1..quantity; open entries show their place in the queue.
 */
export function positionLabel(entry: MyEntry): string {
	const p = entry.position;
	if (p.kind === "won") return `You're #${p.rank}`;
	if (p.kind === "backup") return `Backup #${p.rank}`;
	if (p.kind === "waiting") return `#${p.rank} in line · seller deciding`;
	if (p.kind === "countered") return `Countered at ${formatCents(entry.counterCents ?? entry.amountCents)}`;
	return (entry.endedReason && ENDED[entry.endedReason]) ?? "Ended";
}

/** The sentence a screen reader hears when the buyer's own entry changes. */
function sentence(entry: MyEntry, title: string): string {
	const p = entry.position;
	if (p.kind === "won") return `You're #${p.rank} — ${title} is yours.`;
	if (p.kind === "backup") return `You're backup #${p.rank} for ${title}.`;
	if (p.kind === "waiting") return `The seller is deciding on ${title}. You're #${p.rank} in line.`;
	if (p.kind === "countered") {
		return `The seller countered your offer on ${title} at ${formatCents(entry.counterCents ?? entry.amountCents)}.`;
	}
	return `${title}: ${positionLabel(entry).toLowerCase()}.`;
}

const samePosition = (a: MyEntry, b: MyEntry) =>
	a.status === b.status &&
	a.position.kind === b.position.kind &&
	("rank" in a.position ? a.position.rank : 0) === ("rank" in b.position ? b.position.rank : 0);

/**
 * What changed for the buyer between two versions of an item, as sentences for the
 * page's live region (PLAN §8: live-region announcements for claim results).
 */
export function announcements(before: LiveItem | undefined, after: LiveItem, title: string): string[] {
	const old = new Map((before?.mine ?? []).map((e) => [e.id, e]));
	const out: string[] = [];
	for (const entry of after.mine) {
		const previous = old.get(entry.id);
		if (previous && samePosition(previous, entry)) continue;
		// A buyer leaving the queue knows already; everything else is news.
		if (entry.endedReason === "left_backup_queue" || entry.endedReason === "buyer_withdrew") continue;
		out.push(sentence(entry, title));
	}
	return out;
}

export function saleAnnouncement(before: LiveSale | null, after: LiveSale): string | undefined {
	if (before?.status === after.status) return undefined;
	if (after.status === "live") return "The sale is live. Claims are open.";
	if (after.status === "closed") return "The sale has closed.";
	return undefined;
}

// ---------------------------------------------------------------------------
// Filters (PLAN §8: available only, price range, category, "items I claimed")

export type StatusFilter = "all" | "available" | "backups" | "sold" | "mine";

export interface GridFilter {
	readonly status: StatusFilter;
	/** "" for every game. */
	readonly gameId: string;
	readonly minCents: number | null;
	readonly maxCents: number | null;
}

export const NO_FILTER: GridFilter = { status: "all", gameId: "", minCents: null, maxCents: null };

export interface FilterableItem {
	readonly id: string;
	readonly priceCents: number;
	readonly gameId: string;
	/** The cached state from the page load, until the socket says otherwise. */
	readonly state: LiveItem["state"];
}

/** An item as the sale page lists it (the static part; the live part is a LiveItem). */
export interface GridItem extends FilterableItem {
	readonly title: string;
	readonly quantity: number;
	readonly kind: string;
	readonly condition: string | null;
	readonly photoUrl: string | null;
	readonly offersEnabled: boolean;
}

export function matchesFilter(item: FilterableItem, live: LiveItem | undefined, filter: GridFilter): boolean {
	const state = live?.state ?? item.state;
	if (filter.gameId !== "" && item.gameId !== filter.gameId) return false;
	if (filter.minCents !== null && item.priceCents < filter.minCents) return false;
	if (filter.maxCents !== null && item.priceCents > filter.maxCents) return false;
	const checks: Record<StatusFilter, () => boolean> = {
		all: () => true,
		available: () => state === "available" || state === "deciding",
		backups: () => (live?.claimCount ?? 0) + (live?.offerCount ?? 0) > 0,
		sold: () => state === "sold_out",
		mine: () => (live?.mine ?? []).some((e) => e.position.kind !== "ended"),
	};
	return checks[filter.status]();
}

/** Dollars typed by a buyer ("35", "$35.50") → integer cents, or undefined. */
export function parseDollars(text: string): number | undefined {
	const clean = text.trim().replace(/^\$/, "").replaceAll(",", "");
	if (!/^\d{1,6}(\.\d{1,2})?$/.test(clean)) return undefined;
	const [whole, fraction = ""] = clean.split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	return cents > 0 ? cents : undefined;
}

/** What a buyer can do with their own entry from the grid or the item page. */
export type EntryAction = "withdraw_offer" | "leave_queue" | "accept_counter" | "decline_counter";

/**
 * The actions the engine would accept for this entry now (the engine checks again):
 * an open offer can be withdrawn; an open claim can leave the queue only as a backup,
 * because a claim the seller is deciding on is binding; an unexpired counter can be
 * accepted or declined.
 *
 * @spec SM-4.4-withdraw-offer
 * @spec SM-4.4-leave-backup
 * @spec SM-4.4-counter
 */
export function entryActions(entry: MyEntry | undefined, now: number): EntryAction[] {
	if (!entry) return [];
	if (entry.status === "countered") {
		return entry.counterExpiresAt !== null && now < entry.counterExpiresAt
			? ["accept_counter", "decline_counter"]
			: [];
	}
	if (entry.status !== "open") return [];
	if (entry.kind === "offer") return ["withdraw_offer"];
	return entry.position.kind === "backup" ? ["leave_queue"] : [];
}

/** The button text for an action ("Accept $35.00"). */
export function entryActionLabel(action: EntryAction, entry: MyEntry): string {
	const labels: Record<EntryAction, string> = {
		withdraw_offer: "Withdraw offer",
		leave_queue: "Leave the backup queue",
		accept_counter: `Accept ${formatCents(entry.counterCents ?? entry.amountCents)}`,
		decline_counter: "Decline counter",
	};
	return labels[action];
}
