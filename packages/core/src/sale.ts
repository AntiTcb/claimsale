import { DAY, err, ok, reject, type Millis, type Rejection, type Result, type Tier } from "./common.ts";
import { FREE_ACTIVE_SALE_CAP, FREE_ITEM_CAP, MAX_LIVE_DURATION, MAX_PREVIEW } from "./plans.ts";

/** Sale lifecycle (STATE_MACHINES §2). */

export type SaleStatus = "draft" | "scheduled" | "live" | "closed" | "archived" | "deleted";

export interface Sale {
	readonly status: SaleStatus;
	readonly liveAt: Millis | null;
	readonly closesAt: Millis | null;
	readonly sellerTier: Tier;
	readonly itemCount: number;
}

export type SaleEvent =
	| { readonly type: "sale_scheduled"; readonly liveAt: Millis }
	| { readonly type: "sale_live" }
	| { readonly type: "followers_notified" }
	| { readonly type: "sale_unpublished" }
	| { readonly type: "sale_closed" }
	| { readonly type: "sale_archived" }
	| { readonly type: "sale_deleted" };

export type SaleRejection = Rejection<
	| "invalid_status"
	| "sale_cap_reached"
	| "item_cap_reached"
	| "no_items"
	| "preview_too_early"
	| "live_at_in_past"
	| "closes_before_live"
	| "too_long"
	| "invoices_open"
>;

export interface SaleTransition {
	readonly sale: Sale;
	readonly events: readonly SaleEvent[];
}

type SaleResult = Result<SaleTransition, SaleRejection>;

const transition = (sale: Sale, events: SaleEvent[]): SaleResult => ok({ sale, events });

/**
 * Whether buyers can place claims and offers.
 *
 * @spec SM-2-publish-scheduled — claim buttons are disabled while scheduled.
 * @spec SM-2-close — a closed sale rejects new entries.
 */
export function acceptsEntries(status: SaleStatus): boolean {
	return status === "live";
}

/** Whether buyers can see the sale at all (scheduled sales show a preview). */
export function isVisible(status: SaleStatus): boolean {
	return status === "scheduled" || status === "live" || status === "closed" || status === "archived";
}

/**
 * Checks the free-tier item cap when an item is added.
 *
 * @spec SM-2-free-item-cap
 */
export function canAddItem(sale: Sale): Result<true, SaleRejection> {
	if (sale.status !== "draft" && sale.status !== "scheduled") {
		return reject("invalid_status", "Items can only be added before the sale goes live");
	}
	if (sale.sellerTier === "free" && sale.itemCount >= FREE_ITEM_CAP) {
		return reject("item_cap_reached", `Free sales can have up to ${FREE_ITEM_CAP} items`);
	}
	return ok(true);
}

export interface PublishCommand {
	/** Go-live time, or null to go live now. */
	readonly liveAt: Millis | null;
	readonly closesAt: Millis;
	/** The seller's sales currently scheduled or live, excluding this one. */
	readonly activeSaleCount: number;
}

/**
 * Publishes a draft.
 *
 * @spec SM-2-publish-scheduled — a future `liveAt` → `scheduled`.
 * @spec SM-2-publish-now — no `liveAt` → `live`.
 * @spec SM-2-preview-window — `liveAt` is at most 7 days away.
 * @spec SM-2-max-duration — the live period is at most 14 days.
 * @spec SM-2-free-sale-cap — free sellers have at most 2 sales scheduled or live.
 * @spec SM-2-free-item-cap — and at most 10 items, checked again on publish.
 */
export function publish(sale: Sale, command: PublishCommand, now: Millis): SaleResult {
	if (sale.status !== "draft") return reject("invalid_status", "Only a draft can be published");
	if (sale.itemCount === 0) return reject("no_items", "Add at least one item first");
	if (sale.sellerTier === "free" && sale.itemCount > FREE_ITEM_CAP) {
		return reject("item_cap_reached", `Free sales can have up to ${FREE_ITEM_CAP} items`);
	}
	if (sale.sellerTier === "free" && command.activeSaleCount >= FREE_ACTIVE_SALE_CAP) {
		return reject(
			"sale_cap_reached",
			`Free sellers can have ${FREE_ACTIVE_SALE_CAP} sales scheduled or live`,
		);
	}
	const liveAt = command.liveAt ?? now;
	if (command.liveAt !== null && command.liveAt <= now) {
		return reject("live_at_in_past", "The go-live time must be in the future");
	}
	if (liveAt - now > MAX_PREVIEW) {
		return reject("preview_too_early", "A sale can be scheduled at most 7 days ahead");
	}
	if (command.closesAt <= liveAt)
		return reject("closes_before_live", "The sale must close after it goes live");
	if (command.closesAt - liveAt > MAX_LIVE_DURATION) {
		return reject("too_long", "A sale can run live for at most 14 days");
	}
	if (command.liveAt === null) {
		return transition({ ...sale, status: "live", liveAt: now, closesAt: command.closesAt }, [
			{ type: "sale_live" },
			{ type: "followers_notified" },
		]);
	}
	return transition({ ...sale, status: "scheduled", liveAt: command.liveAt, closesAt: command.closesAt }, [
		{ type: "sale_scheduled", liveAt: command.liveAt },
		{ type: "followers_notified" },
	]);
}

/** Scheduled → draft. */
export function unpublish(sale: Sale): SaleResult {
	if (sale.status !== "scheduled")
		return reject("invalid_status", "Only a scheduled sale can be unpublished");
	return transition({ ...sale, status: "draft", liveAt: null, closesAt: null }, [
		{ type: "sale_unpublished" },
	]);
}

/**
 * The alarm at `liveAt`.
 *
 * @spec SM-2-go-live-alarm — scheduled → live, and followers are notified.
 */
export function goLive(sale: Sale, now: Millis): SaleResult {
	if (sale.status !== "scheduled" || sale.liveAt === null || now < sale.liveAt) {
		return reject("invalid_status", "The sale is not due to go live");
	}
	return transition({ ...sale, status: "live" }, [{ type: "sale_live" }, { type: "followers_notified" }]);
}

/**
 * The seller closes the sale, or the alarm at `closesAt` fires.
 *
 * @spec SM-2-close — new entries are rejected from now on; item timers keep
 * running (see closeItem in item.ts).
 */
export function close(sale: Sale, now: Millis, by: "seller" | "alarm"): SaleResult {
	if (sale.status !== "live") return reject("invalid_status", "Only a live sale can be closed");
	if (by === "alarm" && (sale.closesAt === null || now < sale.closesAt)) {
		return reject("invalid_status", "The sale is not due to close");
	}
	return transition({ ...sale, status: "closed", closesAt: Math.min(sale.closesAt ?? now, now) }, [
		{ type: "sale_closed" },
	]);
}

/** Closed sales are archived after this long even with open invoices. */
export const ARCHIVE_AFTER: Millis = 90 * DAY;

/** Closed → archived once every invoice is completed or cancelled (or after 90 days). */
export function archive(sale: Sale, openInvoices: number, now: Millis): SaleResult {
	if (sale.status !== "closed") return reject("invalid_status", "Only a closed sale can be archived");
	const stale = sale.closesAt !== null && now - sale.closesAt >= ARCHIVE_AFTER;
	if (openInvoices > 0 && !stale) return reject("invoices_open", "Some invoices are still open");
	return transition({ ...sale, status: "archived" }, [{ type: "sale_archived" }]);
}

/** Only drafts can be deleted. */
export function deleteSale(sale: Sale): SaleResult {
	if (sale.status !== "draft") return err({ code: "invalid_status", message: "Only a draft can be deleted" });
	return transition({ ...sale, status: "deleted" }, [{ type: "sale_deleted" }]);
}

/**
 * Which item fields the seller may still change.
 *
 * @spec SM-2-lock-price-qty — once an item has entries, price and quantity are
 * locked; title and photos stay editable (D40).
 */
export function editableItemFields(
	entryCount: number,
): ReadonlySet<"title" | "description" | "photos" | "price" | "quantity"> {
	return entryCount > 0
		? new Set(["title", "description", "photos"] as const)
		: new Set(["title", "description", "photos", "price", "quantity"] as const);
}
