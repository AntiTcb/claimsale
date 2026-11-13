import {
	actorRef,
	ok,
	reject,
	type Actor,
	type Millis,
	type Rejection,
	type Result,
	type Tier,
	type UserId,
} from "./common.ts";
import type { Cents } from "./money.ts";
import { COUNTER_TTL, MIN_RESCIND_EXPLANATION, PRO_BUYER_RESCINDS_PER_MONTH } from "./plans.ts";
import type { RescindReasonCode } from "./rescind.ts";
import type { SaleStatus } from "./sale.ts";

/**
 * Items and their entries (claims and offers): STATE_MACHINES §3 and §4. Each
 * command takes the item with all of its entries and returns the new item plus
 * events, or a rejection. The engine runs these inside the item's lock (§9).
 */

export type EntryKind = "claim" | "offer";

export type EntryStatus =
	| "open"
	| "countered"
	| "won"
	| "declined"
	| "withdrawn"
	| "lost"
	| "ended"
	| "rescinded"
	| "released"
	| "fulfilled";

export const TERMINAL_STATUSES: ReadonlySet<EntryStatus> = new Set([
	"declined",
	"withdrawn",
	"lost",
	"ended",
	"rescinded",
	"released",
	"fulfilled",
]);

export type EndedReason =
	| "seller_declined"
	| "below_minimum"
	| "buyer_withdrew"
	| "left_backup_queue"
	| "counter_declined"
	| "counter_expired"
	| "offer_lapsed"
	| "units_paid"
	| "item_withdrawn"
	| "sale_cancelled"
	| "seller_rescind"
	| "buyer_rescind"
	| "takeback"
	| "invoice_completed";

export interface Entry {
	readonly id: string;
	readonly buyerId: UserId;
	readonly kind: EntryKind;
	readonly amountCents: Cents;
	readonly status: EntryStatus;
	readonly createdAt: Millis;
	/** Set by the seller to reorder backups (D44); lower ranks first. */
	readonly rankOverride: number | null;
	readonly counterCents: Cents | null;
	readonly counterExpiresAt: Millis | null;
	readonly wonAt: Millis | null;
	readonly endedAt: Millis | null;
	readonly endedReason: EndedReason | null;
	/** A user ID or `system`. */
	readonly endedBy: string | null;
}

export interface Item {
	readonly id: string;
	readonly priceCents: Cents;
	readonly quantity: number;
	/** Most units one buyer can hold (D12). */
	readonly perBuyerLimit: number;
	readonly offersEnabled: boolean;
	/** Hidden minimum offer; only applied for Pro sellers (D27). */
	readonly minOfferCents: Cents | null;
	readonly decisionDeadline: Millis | null;
	/** After close: when unaccepted offers on items with free units lapse (D48). */
	readonly offersLapseAt: Millis | null;
	readonly withdrawn: boolean;
	readonly entries: readonly Entry[];
}

/** Sale settings the item rules depend on. */
export interface ItemContext {
	readonly saleStatus: SaleStatus;
	readonly sellerId: UserId;
	readonly sellerTier: Tier;
	/** D34: every claim waits for the seller. */
	readonly reviewEveryClaim: boolean;
	/** D43: offers on sold-out items (backups). On by default. */
	readonly allowBackupOffers: boolean;
	/** From decisionWindow() (D25). */
	readonly decisionWindow: Millis;
	readonly buyerRequirements: { readonly emailVerified: boolean; readonly minAccountAge: Millis };
}

export interface Buyer {
	readonly id: UserId;
	readonly tier: Tier;
	readonly blocked: boolean;
	readonly emailVerified: boolean;
	readonly accountCreatedAt: Millis;
}

export type WinVia = "instant" | "award" | "window" | "promotion" | "counter";

export type ItemEvent =
	| { readonly type: "entry_placed"; readonly entryId: string; readonly status: EntryStatus }
	| {
			readonly type: "entry_won";
			readonly entryId: string;
			readonly buyerId: UserId;
			readonly amountCents: Cents;
			readonly via: WinVia;
	  }
	| {
			readonly type: "entry_ended";
			readonly entryId: string;
			readonly status: EntryStatus;
			readonly reason: EndedReason;
	  }
	| { readonly type: "entry_reopened"; readonly entryId: string; readonly amountCents: Cents }
	| {
			readonly type: "counter_sent";
			readonly entryId: string;
			readonly amountCents: Cents;
			readonly expiresAt: Millis;
	  }
	| { readonly type: "decision_deadline_set"; readonly at: Millis }
	| { readonly type: "decision_deadline_cleared" }
	| { readonly type: "offers_lapse_set"; readonly at: Millis }
	| {
			readonly type: "seller_notified";
			readonly reason: "new_offer" | "claim_needs_decision" | "backup_below_asking";
	  }
	| {
			readonly type: "winner_removed";
			readonly entryId: string;
			readonly buyerId: UserId;
			readonly by: "seller" | "buyer" | "takeback";
			readonly reasonCode: RescindReasonCode | null;
	  }
	| { readonly type: "item_withdrawn" }
	| { readonly type: "ranking_changed" };

export type ItemRejection = Rejection<
	| "sale_not_live"
	| "not_allowed"
	| "buyer_blocked"
	| "email_not_verified"
	| "account_too_new"
	| "unit_limit_reached"
	| "already_entered"
	| "offers_disabled"
	| "backup_offers_disabled"
	| "invalid_amount"
	| "item_withdrawn"
	| "entry_not_found"
	| "invalid_status"
	| "no_free_unit"
	| "already_countered"
	| "counter_expired"
	| "not_due"
	| "claim_is_binding"
	| "explanation_too_short"
	| "confirmation_required"
	| "invoice_sent"
	| "rescind_limit_reached"
	| "pro_only"
>;

export interface ItemTransition {
	readonly item: Item;
	readonly events: readonly ItemEvent[];
}

export type ItemResult = Result<ItemTransition, ItemRejection>;

// ---------------------------------------------------------------------------
// Queries

const holdsUnit = (entry: Entry) => entry.status === "won" || entry.status === "fulfilled";
const isPending = (entry: Entry) => entry.status === "open" || entry.status === "countered";

export function unitsHeld(item: Item): number {
	return item.entries.filter(holdsUnit).length;
}

export function freeUnits(item: Item): number {
	return Math.max(0, item.quantity - unitsHeld(item));
}

export function openEntries(item: Item): Entry[] {
	return item.entries.filter((entry) => entry.status === "open");
}

const hasOpenClaim = (item: Item) => item.entries.some((e) => e.status === "open" && e.kind === "claim");
const hasPendingOffer = (item: Item) => item.entries.some((e) => isPending(e) && e.kind === "offer");

/**
 * The order of open entries.
 *
 * @spec SM-4.2-ranking — amount descending, then time ascending (D44). Entries
 * the seller reordered come first, in the seller's order. The entry ID breaks any
 * remaining tie, so the order is total.
 */
export function compareRank(a: Entry, b: Entry): number {
	if (a.rankOverride !== null || b.rankOverride !== null) {
		if (a.rankOverride === null) return 1;
		if (b.rankOverride === null) return -1;
		if (a.rankOverride !== b.rankOverride) return a.rankOverride - b.rankOverride;
	}
	if (a.amountCents !== b.amountCents) return b.amountCents - a.amountCents;
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankedOpenEntries(item: Item): Entry[] {
	return openEntries(item).toSorted(compareRank);
}

export type ItemState = "available" | "deciding" | "sold_out" | "withdrawn" | "unsold";

/**
 * The item's displayed state, derived from units, entries and the deadline.
 *
 * @spec SM-3-derived-state
 */
export function deriveItemState(item: Item, saleStatus: SaleStatus): ItemState {
	if (item.withdrawn) return "withdrawn";
	if (freeUnits(item) === 0) return "sold_out";
	if (item.decisionDeadline !== null) return "deciding";
	const closed = saleStatus === "closed" || saleStatus === "archived";
	if (closed && !item.entries.some(isPending)) return "unsold";
	return "available";
}

// ---------------------------------------------------------------------------
// Helpers

function findEntry(item: Item, entryId: string): Result<Entry, ItemRejection> {
	const entry = item.entries.find((e) => e.id === entryId);
	return entry ? ok(entry) : reject("entry_not_found", "No such entry on this item");
}

function withEntry(item: Item, entry: Entry): Item {
	return { ...item, entries: item.entries.map((e) => (e.id === entry.id ? entry : e)) };
}

function end(entry: Entry, status: EntryStatus, reason: EndedReason, actor: Actor, now: Millis): Entry {
	return { ...entry, status, endedAt: now, endedReason: reason, endedBy: actorRef(actor) };
}

const endedEvent = (entry: Entry): ItemEvent => ({
	type: "entry_ended",
	entryId: entry.id,
	status: entry.status,
	reason: entry.endedReason ?? "item_withdrawn",
});

function win(entry: Entry, amountCents: Cents, now: Millis): Entry {
	return { ...entry, status: "won", amountCents, wonAt: now };
}

const wonEvent = (entry: Entry, via: WinVia): ItemEvent => ({
	type: "entry_won",
	entryId: entry.id,
	buyerId: entry.buyerId,
	amountCents: entry.amountCents,
	via,
});

function isSeller(actor: Actor, context: ItemContext): boolean {
	return actor.kind === "seller" && actor.id === context.sellerId;
}

const notAllowed = (): ItemResult => reject("not_allowed", "You can't do that on this item");

/** Clears the decision deadline when no unit is free or no open claim remains (§4.2). */
function settleDeadline(item: Item, events: ItemEvent[]): Item {
	if (item.decisionDeadline !== null && (freeUnits(item) === 0 || !hasOpenClaim(item))) {
		events.push({ type: "decision_deadline_cleared" });
		return { ...item, decisionDeadline: null };
	}
	return item;
}

// ---------------------------------------------------------------------------
// 4.1 Placing an entry

export interface PlaceCommand {
	/** Generated by the caller (UUIDv7), so the function stays pure. */
	readonly entryId: string;
	readonly kind: EntryKind;
	/** Offers only; a claim is always at the asking price. */
	readonly amountCents?: Cents;
}

/**
 * Places a claim or an offer.
 *
 * @spec SM-4.1-instant-win — a claim with a free unit, no pending offers, no review mode and no deadline wins.
 * @spec SM-4.1-deciding — a claim with a free unit and pending offers (or review mode) waits, and starts the window.
 * @spec SM-4.1-backup-claim — a claim on a sold-out item is a backup.
 * @spec SM-4.1-offer-open — an offer is open, never wins on its own and starts no window.
 * @spec SM-4.1-backup-offer-toggle — offers on sold-out items follow the sale's toggle (D43).
 * @spec SM-4.1-min-offer — a Pro seller's hidden minimum auto-declines lower offers (D27).
 * @spec SM-4.1-one-open-entry — one open or countered entry per buyer per item.
 * @spec SM-4.1-unit-limit — the per-buyer unit limit (D12).
 * @spec SM-4.1-buyer-requirements — blocked buyers are rejected; Pro buyers skip the email and account-age requirements (D29).
 */
export function place(
	item: Item,
	context: ItemContext,
	buyer: Buyer,
	command: PlaceCommand,
	now: Millis,
): ItemResult {
	if (context.saleStatus !== "live")
		return reject("sale_not_live", "This sale isn't taking claims or offers");
	if (item.withdrawn) return reject("item_withdrawn", "This item was withdrawn");
	if (buyer.id === context.sellerId) return notAllowed();
	if (buyer.blocked) return reject("buyer_blocked", "You can't join this sale");
	if (buyer.tier !== "pro") {
		if (context.buyerRequirements.emailVerified && !buyer.emailVerified) {
			return reject("email_not_verified", "Verify your email address first");
		}
		if (now - buyer.accountCreatedAt < context.buyerRequirements.minAccountAge) {
			return reject("account_too_new", "This sale requires an older account");
		}
	}
	const mine = item.entries.filter((e) => e.buyerId === buyer.id);
	if (mine.some(isPending))
		return reject("already_entered", "You already have a claim or offer on this item");
	if (mine.filter(holdsUnit).length >= item.perBuyerLimit) {
		return reject("unit_limit_reached", "You've reached the limit for this item");
	}

	const base = {
		id: command.entryId,
		buyerId: buyer.id,
		createdAt: now,
		rankOverride: null,
		counterCents: null,
		counterExpiresAt: null,
		wonAt: null,
		endedAt: null,
		endedReason: null,
		endedBy: null,
	} as const;
	const free = freeUnits(item);
	const events: ItemEvent[] = [];

	if (command.kind === "claim") {
		const entry: Entry = { ...base, kind: "claim", amountCents: item.priceCents, status: "open" };
		const instant =
			free > 0 && !hasPendingOffer(item) && !context.reviewEveryClaim && item.decisionDeadline === null;
		if (instant) {
			const won = win(entry, item.priceCents, now);
			return ok({ item: { ...item, entries: [...item.entries, won] }, events: [wonEvent(won, "instant")] });
		}
		let next: Item = { ...item, entries: [...item.entries, entry] };
		events.push({ type: "entry_placed", entryId: entry.id, status: "open" });
		if (free > 0) {
			if (next.decisionDeadline === null) {
				const at = now + context.decisionWindow;
				next = { ...next, decisionDeadline: at };
				events.push({ type: "decision_deadline_set", at });
			}
			events.push({ type: "seller_notified", reason: "claim_needs_decision" });
		}
		return ok({ item: next, events });
	}

	if (!item.offersEnabled) return reject("offers_disabled", "This item doesn't take offers");
	const amount = command.amountCents;
	if (amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
		return reject("invalid_amount", "Enter an offer amount");
	}
	if (free === 0 && !context.allowBackupOffers) {
		return reject("backup_offers_disabled", "This item is sold out");
	}
	const entry: Entry = { ...base, kind: "offer", amountCents: amount, status: "open" };
	if (context.sellerTier === "pro" && item.minOfferCents !== null && amount < item.minOfferCents) {
		const declined = end(entry, "declined", "below_minimum", { kind: "system" }, now);
		return ok({ item: { ...item, entries: [...item.entries, declined] }, events: [endedEvent(declined)] });
	}
	return ok({
		item: { ...item, entries: [...item.entries, entry] },
		events: [
			{ type: "entry_placed", entryId: entry.id, status: "open" },
			{ type: "seller_notified", reason: "new_offer" },
		],
	});
}

// ---------------------------------------------------------------------------
// 4.2 Awarding

/**
 * The seller awards an open entry.
 *
 * @spec SM-4.2-award — needs a free unit; other open entries stay open (as backups if sold out).
 */
export function award(
	item: Item,
	context: ItemContext,
	actor: Actor,
	entryId: string,
	now: Millis,
): ItemResult {
	if (!isSeller(actor, context)) return notAllowed();
	const found = findEntry(item, entryId);
	if (!found.ok) return found;
	if (found.value.status !== "open") return reject("invalid_status", "Only an open entry can be awarded");
	if (freeUnits(item) === 0) return reject("no_free_unit", "No unit is free");
	const won = win(found.value, found.value.amountCents, now);
	const events: ItemEvent[] = [wonEvent(won, "award")];
	const next = settleDeadline(withEntry(item, won), events);
	return ok({ item: next, events });
}

/**
 * The decision deadline passed (DO alarm).
 *
 * @spec SM-4.2-window-expiry — the earliest open claims win while units are free; offers never win this way.
 */
export function expireDecisionWindow(item: Item, now: Millis): ItemResult {
	if (item.decisionDeadline === null || now < item.decisionDeadline) {
		return reject("not_due", "The decision window hasn't ended");
	}
	let next = item;
	const events: ItemEvent[] = [];
	const claims = openEntries(item)
		.filter((e) => e.kind === "claim")
		.toSorted((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
	for (const claim of claims) {
		if (freeUnits(next) === 0) break;
		const won = win(claim, claim.amountCents, now);
		next = withEntry(next, won);
		events.push(wonEvent(won, "window"));
	}
	events.push({ type: "decision_deadline_cleared" });
	return ok({ item: { ...next, decisionDeadline: null }, events });
}

/**
 * The seller reorders backups.
 *
 * @spec SM-4.2-ranking — the seller can override the default order (D44).
 */
export function reorder(
	item: Item,
	context: ItemContext,
	actor: Actor,
	orderedEntryIds: readonly string[],
): ItemResult {
	if (!isSeller(actor, context)) return notAllowed();
	const open = new Set(openEntries(item).map((e) => e.id));
	if (
		orderedEntryIds.some((id) => !open.has(id)) ||
		new Set(orderedEntryIds).size !== orderedEntryIds.length
	) {
		return reject("invalid_status", "Only open entries can be reordered, each once");
	}
	const position = new Map(orderedEntryIds.map((id, i) => [id, i]));
	const entries = item.entries.map((e) =>
		e.status === "open" ? { ...e, rankOverride: position.get(e.id) ?? null } : e,
	);
	return ok({ item: { ...item, entries }, events: [{ type: "ranking_changed" }] });
}

// ---------------------------------------------------------------------------
// 4.4 Counters, declines and withdrawals

/**
 * The seller counters an open offer.
 *
 * @spec SM-4.4-counter — one round only (D48); the counter is open for 24h.
 */
export function counter(
	item: Item,
	context: ItemContext,
	actor: Actor,
	entryId: string,
	amountCents: Cents,
	now: Millis,
): ItemResult {
	if (!isSeller(actor, context)) return notAllowed();
	const found = findEntry(item, entryId);
	if (!found.ok) return found;
	const entry = found.value;
	if (entry.kind !== "offer" || entry.status !== "open")
		return reject("invalid_status", "Only an open offer can be countered");
	if (entry.counterCents !== null) return reject("already_countered", "An offer can be countered once");
	if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
		return reject("invalid_amount", "Enter a counter amount");
	const expiresAt = now + COUNTER_TTL;
	const countered: Entry = {
		...entry,
		status: "countered",
		counterCents: amountCents,
		counterExpiresAt: expiresAt,
	};
	return ok({
		item: withEntry(item, countered),
		events: [{ type: "counter_sent", entryId, amountCents, expiresAt }],
	});
}

/**
 * The buyer accepts or declines a counter.
 *
 * @spec SM-4.4-counter — accept → won if a unit is free, else open (a backup) at the counter amount.
 */
export function respondToCounter(
	item: Item,
	actor: Actor,
	entryId: string,
	accept: boolean,
	now: Millis,
): ItemResult {
	const found = findEntry(item, entryId);
	if (!found.ok) return found;
	const entry = found.value;
	if (actor.kind !== "buyer" || actor.id !== entry.buyerId) return notAllowed();
	if (entry.status !== "countered" || entry.counterCents === null || entry.counterExpiresAt === null) {
		return reject("invalid_status", "There's no counter to answer");
	}
	if (now >= entry.counterExpiresAt) return reject("counter_expired", "The counter has expired");
	if (!accept) {
		const declined = end(entry, "declined", "counter_declined", actor, now);
		return ok({ item: withEntry(item, declined), events: [endedEvent(declined)] });
	}
	if (freeUnits(item) > 0) {
		const won = win(entry, entry.counterCents, now);
		const events: ItemEvent[] = [wonEvent(won, "counter")];
		return ok({ item: settleDeadline(withEntry(item, won), events), events });
	}
	const reopened: Entry = {
		...entry,
		status: "open",
		amountCents: entry.counterCents,
		counterExpiresAt: null,
	};
	return ok({
		item: withEntry(item, reopened),
		events: [{ type: "entry_reopened", entryId, amountCents: entry.counterCents }],
	});
}

/**
 * A counter's 24h passed (DO alarm).
 *
 * @spec SM-4.4-counter-expiry
 */
export function expireCounter(item: Item, entryId: string, now: Millis): ItemResult {
	const found = findEntry(item, entryId);
	if (!found.ok) return found;
	const entry = found.value;
	if (entry.status !== "countered" || entry.counterExpiresAt === null || now < entry.counterExpiresAt) {
		return reject("not_due", "The counter hasn't expired");
	}
	const declined = end(entry, "declined", "counter_expired", { kind: "system" }, now);
	return ok({ item: withEntry(item, declined), events: [endedEvent(declined)] });
}

/** The seller declines an open or countered offer. */
export function declineOffer(
	item: Item,
	context: ItemContext,
	actor: Actor,
	entryId: string,
	now: Millis,
): ItemResult {
	if (!isSeller(actor, context)) return notAllowed();
	const found = findEntry(item, entryId);
	if (!found.ok) return found;
	if (found.value.kind !== "offer" || !isPending(found.value)) {
		return reject("invalid_status", "Only a pending offer can be declined");
	}
	const declined = end(found.value, "declined", "seller_declined", actor, now);
	return ok({ item: withEntry(item, declined), events: [endedEvent(declined)] });
}

/**
 * The buyer withdraws an entry.
 *
 * @spec SM-4.4-withdraw-offer — an offer can be withdrawn until it's accepted (D46).
 * @spec SM-4.4-leave-backup — a backup claim can leave the queue until promoted (D14).
 *
 * A claim that is waiting on a free unit is binding and can't be withdrawn.
 */
export function withdraw(item: Item, actor: Actor, entryId: string, now: Millis): ItemResult {
	const found = findEntry(item, entryId);
	if (!found.ok) return found;
	const entry = found.value;
	if (actor.kind !== "buyer" || actor.id !== entry.buyerId) return notAllowed();
	if (entry.status !== "open") return reject("invalid_status", "Only an open entry can be withdrawn");
	if (entry.kind === "claim" && freeUnits(item) > 0) {
		return reject("claim_is_binding", "A claim can't be withdrawn while it's being decided");
	}
	const reason: EndedReason = entry.kind === "offer" ? "buyer_withdrew" : "left_backup_queue";
	const withdrawn = end(entry, "withdrawn", reason, actor, now);
	return ok({ item: withEntry(item, withdrawn), events: [endedEvent(withdrawn)] });
}

// ---------------------------------------------------------------------------
// 4.3 Removing a winner and promoting

/**
 * Fills free units from the backups after a winner is removed.
 *
 * @spec SM-4.3-promote-auto — the best backup at or above asking wins.
 * @spec SM-4.3-promote-below-asking — below asking, the decision window restarts (D45).
 */
export function promote(item: Item, context: ItemContext, now: Millis): ItemTransition {
	if (item.withdrawn) return { item, events: [] };
	let next = item;
	const events: ItemEvent[] = [];
	while (freeUnits(next) > 0) {
		const best = rankedOpenEntries(next)[0];
		if (best === undefined) break;
		if (best.amountCents >= next.priceCents) {
			const won = win(best, best.amountCents, now);
			next = withEntry(next, won);
			events.push(wonEvent(won, "promotion"));
			continue;
		}
		const at = now + context.decisionWindow;
		next = { ...next, decisionDeadline: at };
		events.push(
			{ type: "decision_deadline_set", at },
			{ type: "seller_notified", reason: "backup_below_asking" },
		);
		break;
	}
	return { item: next, events };
}

/** Ends every pending entry and marks the item withdrawn. Winners stay won (they're binding). */
export function withdrawItem(item: Item, context: ItemContext, actor: Actor, now: Millis): ItemResult {
	if (!isSeller(actor, context)) return notAllowed();
	if (item.withdrawn) return reject("item_withdrawn", "The item is already withdrawn");
	return ok(endPendingAndWithdraw(item, actor, now));
}

function endPendingAndWithdraw(item: Item, actor: Actor, now: Millis): ItemTransition {
	const events: ItemEvent[] = [];
	const entries = item.entries.map((e) => {
		if (!isPending(e)) return e;
		const ended = end(e, "ended", "item_withdrawn", actor, now);
		events.push(endedEvent(ended));
		return ended;
	});
	events.push({ type: "item_withdrawn" });
	if (item.decisionDeadline !== null) events.push({ type: "decision_deadline_cleared" });
	return { item: { ...item, entries, withdrawn: true, decisionDeadline: null, offersLapseAt: null }, events };
}

export interface SellerRescindCommand {
	readonly entryId: string;
	readonly reasonCode: RescindReasonCode;
	readonly explanation: string;
	/** "Rescind and pass to next" (D13); otherwise the item is withdrawn. */
	readonly passToNext: boolean;
	/** The buyer already marked the invoice paid. */
	readonly afterBuyerPaid: boolean;
	/** The seller confirmed the extra prompt shown after payment. */
	readonly confirmed: boolean;
}

/**
 * The seller rescinds a winning entry.
 *
 * @spec SM-4.3-seller-rescind — a reason code and a written explanation (20+ characters) are required;
 * after the buyer paid, an extra confirmation too.
 * @spec SM-4.3-rescind-withdraw — a plain rescind (not "pass to next") withdraws the item.
 */
export function sellerRescind(
	item: Item,
	context: ItemContext,
	actor: Actor,
	command: SellerRescindCommand,
	now: Millis,
): ItemResult {
	if (!isSeller(actor, context)) return notAllowed();
	const found = findEntry(item, command.entryId);
	if (!found.ok) return found;
	if (found.value.status !== "won") return reject("invalid_status", "Only a winning entry can be rescinded");
	if (command.explanation.trim().length < MIN_RESCIND_EXPLANATION) {
		return reject(
			"explanation_too_short",
			`Explain the rescind in at least ${MIN_RESCIND_EXPLANATION} characters`,
		);
	}
	if (command.afterBuyerPaid && !command.confirmed) {
		return reject("confirmation_required", "The buyer has marked this paid; confirm the rescind");
	}
	const rescinded = end(found.value, "rescinded", "seller_rescind", actor, now);
	const events: ItemEvent[] = [
		endedEvent(rescinded),
		{
			type: "winner_removed",
			entryId: rescinded.id,
			buyerId: rescinded.buyerId,
			by: "seller",
			reasonCode: command.reasonCode,
		},
	];
	const removed = withEntry(item, rescinded);
	const after = command.passToNext
		? promote(removed, context, now)
		: endPendingAndWithdraw(removed, actor, now);
	return ok({ item: after.item, events: [...events, ...after.events] });
}

export interface BuyerRescindCommand {
	readonly entryId: string;
	/** The invoice holding the entry has been sent (or later). */
	readonly invoiceSent: boolean;
	/** This buyer's Pro rescinds so far this calendar month. */
	readonly rescindsThisMonth: number;
}

/**
 * A Pro buyer rescinds their own win.
 *
 * @spec SM-4.3-pro-rescind — until the invoice is sent, at most 5 per month (D24).
 */
export function buyerRescind(
	item: Item,
	context: ItemContext,
	actor: Actor,
	command: BuyerRescindCommand,
	now: Millis,
): ItemResult {
	const found = findEntry(item, command.entryId);
	if (!found.ok) return found;
	const entry = found.value;
	if (actor.kind !== "buyer" || actor.id !== entry.buyerId) return notAllowed();
	if (actor.tier !== "pro")
		return reject("pro_only", "Rescinding a win is a Pro feature; request a take-back instead");
	if (entry.status !== "won") return reject("invalid_status", "Only a winning entry can be rescinded");
	if (command.invoiceSent) return reject("invoice_sent", "The invoice was sent; request a take-back instead");
	if (command.rescindsThisMonth >= PRO_BUYER_RESCINDS_PER_MONTH) {
		return reject("rescind_limit_reached", `You can rescind ${PRO_BUYER_RESCINDS_PER_MONTH} wins a month`);
	}
	return ok(release(item, context, entry, "buyer_rescind", "buyer", actor, now));
}

/** A take-back was approved: the entry is released and promote() runs (§5). */
export function releaseForTakeback(
	item: Item,
	context: ItemContext,
	actor: Actor,
	entryId: string,
	now: Millis,
): ItemResult {
	if (!isSeller(actor, context)) return notAllowed();
	const found = findEntry(item, entryId);
	if (!found.ok) return found;
	if (found.value.status !== "won") return reject("invalid_status", "Only a winning entry can be released");
	return ok(release(item, context, found.value, "takeback", "takeback", actor, now));
}

function release(
	item: Item,
	context: ItemContext,
	entry: Entry,
	reason: EndedReason,
	by: "buyer" | "takeback",
	actor: Actor,
	now: Millis,
): ItemTransition {
	const released = end(entry, "released", reason, actor, now);
	const promoted = promote(withEntry(item, released), context, now);
	return {
		item: promoted.item,
		events: [
			endedEvent(released),
			{ type: "winner_removed", entryId: released.id, buyerId: released.buyerId, by, reasonCode: null },
			...promoted.events,
		],
	};
}

// ---------------------------------------------------------------------------
// 4.5 Sale close and after

/**
 * The sale closed: start the timers that keep running after close.
 *
 * @spec SM-2-close — items keep their deadlines; open claims with free units get a window.
 * @spec SM-4.5-close-offers-lapse — pending offers on items with free units get one window to be accepted.
 * @spec SM-4.5-close-unsold — an item with no pending entries and free units shows as `unsold`.
 */
export function closeItem(item: Item, context: ItemContext, now: Millis): ItemTransition {
	if (item.withdrawn || freeUnits(item) === 0) return { item, events: [] };
	let next = item;
	const events: ItemEvent[] = [];
	if (hasOpenClaim(next) && next.decisionDeadline === null) {
		const at = now + context.decisionWindow;
		next = { ...next, decisionDeadline: at };
		events.push({ type: "decision_deadline_set", at });
	}
	if (hasPendingOffer(next) && next.offersLapseAt === null) {
		const at = now + context.decisionWindow;
		next = { ...next, offersLapseAt: at };
		events.push({ type: "offers_lapse_set", at });
	}
	return { item: next, events };
}

/**
 * The post-close offer window passed: offers still pending on items with free units lapse.
 *
 * @spec SM-4.5-close-offers-lapse
 */
export function lapseOffersAfterClose(item: Item, now: Millis): ItemResult {
	if (item.offersLapseAt === null || now < item.offersLapseAt)
		return reject("not_due", "Offers haven't lapsed yet");
	const events: ItemEvent[] = [];
	const free = freeUnits(item) > 0;
	const entries = item.entries.map((e) => {
		if (!free || e.kind !== "offer" || !isPending(e)) return e;
		const lost = end(e, "lost", "offer_lapsed", { kind: "system" }, now);
		events.push(endedEvent(lost));
		return lost;
	});
	return ok({ item: { ...item, entries, offersLapseAt: null }, events });
}

/**
 * Every unit of the item is paid for and the sale is closed: backups are lost.
 *
 * @spec SM-4.5-backups-lost
 */
export function loseBackups(
	item: Item,
	saleStatus: SaleStatus,
	paidUnits: number,
	now: Millis,
): ItemTransition {
	const closed = saleStatus === "closed" || saleStatus === "archived";
	if (!closed || paidUnits < item.quantity) return { item, events: [] };
	const events: ItemEvent[] = [];
	const entries = item.entries.map((e) => {
		if (!isPending(e)) return e;
		const lost = end(e, "lost", "units_paid", { kind: "system" }, now);
		events.push(endedEvent(lost));
		return lost;
	});
	return { item: { ...item, entries }, events };
}

/** The invoice holding these entries was completed. */
export function fulfill(item: Item, entryIds: ReadonlySet<string>, now: Millis): ItemTransition {
	const events: ItemEvent[] = [];
	const entries = item.entries.map((e) => {
		if (e.status !== "won" || !entryIds.has(e.id)) return e;
		const done = end(e, "fulfilled", "invoice_completed", { kind: "system" }, now);
		events.push(endedEvent(done));
		return done;
	});
	return { item: { ...item, entries }, events };
}
