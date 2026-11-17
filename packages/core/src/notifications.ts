import { MINUTE, type Millis, type UserId } from "./common.ts";
import { CONDITIONS, conditionAtLeast, type Condition } from "./games.ts";
import { formatCents } from "./money.ts";

/**
 * Notifications (PLAN §5 "Notifications", D41, D61; milestone 9, WS-K). Pure: the engine's
 * queue consumer reads what a sale's committed events refer to, asks this module who is told
 * what, and writes `notifications` rows; the web Worker shows them under the bell. The same
 * copy (`describeNotification`) is used in the bell list and in emails.
 */

/** What a user can turn email off for. In-app notifications are always on. */
export const NOTIFICATION_CATEGORIES = [
	"purchases",
	"selling",
	"followed_sellers",
	"want_list",
	"messages",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<NotificationCategory, { label: string; hint: string }>> = {
	purchases: { label: "Your claims and offers", hint: "Wins, promotions, counters, invoices and shipping" },
	selling: { label: "Your sales", hint: "New claims and offers, payments; batched every few minutes" },
	followed_sellers: { label: "Sellers you follow", hint: "New sales from them" },
	want_list: { label: "Want list matches", hint: "A card on your want list is listed in a public sale" },
	messages: { label: "Messages", hint: "Only when a message stays unread for 10 minutes" },
};

export const NOTIFICATION_TYPES = [
	// Buyer side
	"claim_won",
	"claim_promoted",
	"offer_countered",
	"offer_declined",
	"win_rescinded",
	"invoice_sent",
	"invoice_overdue",
	"payment_not_received",
	"payment_confirmed",
	"invoice_shipped",
	// Seller side (emailed as a digest)
	"seller_new_claim",
	"seller_new_offer",
	"seller_decision_needed",
	"seller_buyer_paid",
	"seller_takeback_requested",
	// Discovery
	"followed_sale_scheduled",
	"followed_sale_live",
	"want_list_match",
	// Messaging
	"new_message",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const CATEGORY: Readonly<Record<NotificationType, NotificationCategory>> = {
	claim_won: "purchases",
	claim_promoted: "purchases",
	offer_countered: "purchases",
	offer_declined: "purchases",
	win_rescinded: "purchases",
	invoice_sent: "purchases",
	invoice_overdue: "purchases",
	payment_not_received: "purchases",
	payment_confirmed: "purchases",
	invoice_shipped: "purchases",
	seller_new_claim: "selling",
	seller_new_offer: "selling",
	seller_decision_needed: "selling",
	seller_buyer_paid: "selling",
	seller_takeback_requested: "selling",
	followed_sale_scheduled: "followed_sellers",
	followed_sale_live: "followed_sellers",
	want_list_match: "want_list",
	new_message: "messages",
};

export function categoryOf(type: NotificationType): NotificationCategory {
	return CATEGORY[type];
}

export function isNotificationType(value: string): value is NotificationType {
	return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** Flat values only, so a payload is safe to store as JSON and to render anywhere. */
export type NotificationPayload = Readonly<Record<string, string | number | null>>;

/** One notification to write. `dedupeKey` makes a redelivered queue message a no-op. */
export interface NotificationDraft {
	readonly userId: UserId;
	readonly type: NotificationType;
	readonly dedupeKey: string;
	readonly payload: NotificationPayload;
}

// ---------------------------------------------------------------------------
// Email delivery decisions

/** How long a seller's activity collects before one digest email goes out. */
export const SELLER_DIGEST_WINDOW: Millis = 5 * MINUTE;
/** A message is emailed only if it is still unread this long after it was sent (PLAN §3 Messaging). */
export const MESSAGE_EMAIL_DELAY: Millis = 10 * MINUTE;

export type EmailStatus = "pending" | "batched" | "sent" | "off" | "skipped" | "failed";

export interface Recipient {
	readonly emailVerified: boolean;
	/** Categories the user turned email off for. */
	readonly emailOff: ReadonlySet<NotificationCategory>;
}

/**
 * Whether and when a notification is emailed.
 *
 * @spec NOTIF-preferences — email only for categories the user left on, only to a verified address;
 * the in-app notification is written either way.
 * @spec NOTIF-seller-batch — seller activity waits for the digest; messages wait for the unread delay.
 */
export function emailPlan(
	type: NotificationType,
	recipient: Recipient,
	now: Millis,
): { readonly status: EmailStatus; readonly dueAt: Millis | null } {
	const category = categoryOf(type);
	if (recipient.emailOff.has(category)) return { status: "off", dueAt: null };
	if (!recipient.emailVerified) return { status: "skipped", dueAt: null };
	if (category === "selling") return { status: "batched", dueAt: now + SELLER_DIGEST_WINDOW };
	if (category === "messages") return { status: "pending", dueAt: now + MESSAGE_EMAIL_DELAY };
	return { status: "pending", dueAt: null };
}

/** Reads a stored payload (JSON), keeping only flat string, number and null values. */
export function parseNotificationPayload(stored: unknown): NotificationPayload {
	let value: unknown = stored;
	if (typeof stored === "string") {
		try {
			value = JSON.parse(stored);
		} catch {
			return {};
		}
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string | number | null] =>
				typeof entry[1] === "string" || typeof entry[1] === "number" || entry[1] === null,
		),
	);
}

/** Reads the stored preference (a JSON array of categories), ignoring anything unknown. */
export function parseEmailOff(stored: unknown): Set<NotificationCategory> {
	let value: unknown = stored;
	if (typeof stored === "string") {
		try {
			value = JSON.parse(stored);
		} catch {
			return new Set();
		}
	}
	if (!Array.isArray(value)) return new Set();
	return new Set(
		value.filter((v): v is NotificationCategory =>
			(NOTIFICATION_CATEGORIES as readonly unknown[]).includes(v),
		),
	);
}

// ---------------------------------------------------------------------------
// Sale events → notifications

/** What the consumer read from D1 about the things a batch of events refers to. */
export interface SaleEventContext {
	readonly sale: {
		readonly id: string;
		readonly slug: string;
		readonly title: string;
		readonly sellerId: UserId;
		readonly visibility: string;
		readonly liveAt: Millis | null;
	};
	readonly entries: ReadonlyMap<string, { readonly buyerId: UserId; readonly kind: "claim" | "offer" }>;
	readonly items: ReadonlyMap<string, { readonly title: string }>;
	readonly invoices: ReadonlyMap<string, { readonly buyerId: UserId; readonly totalCents: number }>;
}

/** Follow-up work a batch of events asks for, beyond direct notifications. */
export interface SaleEventFollowUps {
	/** Tell the seller's followers (SM-2-go-live-alarm, followers part). */
	readonly followers: "scheduled" | "live" | null;
	/** Match the sale's listings against want lists (TCG-want-list-notify). */
	readonly matchWantLists: boolean;
	/** Send the invite list its emails (allowlist invites, deferred from WS-A). */
	readonly sendInvites: boolean;
}

/** The IDs a batch of events refers to, so the consumer knows what to read. */
export function referencedIds(events: readonly unknown[]): {
	entryIds: string[];
	itemIds: string[];
	invoiceIds: string[];
} {
	const entryIds = new Set<string>();
	const itemIds = new Set<string>();
	const invoiceIds = new Set<string>();
	for (const event of events) {
		const e = asRecord(event);
		if (typeof e["entryId"] === "string") entryIds.add(e["entryId"]);
		if (typeof e["itemId"] === "string") itemIds.add(e["itemId"]);
		if (typeof e["invoiceId"] === "string") invoiceIds.add(e["invoiceId"]);
	}
	return { entryIds: [...entryIds], itemIds: [...itemIds], invoiceIds: [...invoiceIds] };
}

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Who is told what about one committed batch of a sale's events. `keyPrefix` identifies the
 * batch (the queue message), so a redelivered batch maps to the same keys.
 *
 * @spec NOTIF-idempotent — every draft's key is derived from the batch and the event's position.
 * @spec SM-2-go-live-alarm — going live (and scheduling) asks for the followers to be told.
 */
export function notificationsForSaleEvents(
	events: readonly unknown[],
	context: SaleEventContext,
	keyPrefix: string,
): { drafts: NotificationDraft[]; followUps: SaleEventFollowUps } {
	const { sale } = context;
	const drafts: NotificationDraft[] = [];
	const base = { saleId: sale.id, saleSlug: sale.slug, saleTitle: sale.title };
	let followers: SaleEventFollowUps["followers"] = null;
	let published = false;
	const types = new Set(events.map((e) => str(asRecord(e)["type"])));

	events.forEach((raw, index) => {
		const e = asRecord(raw);
		const dedupeKey = `${keyPrefix}:${index}`;
		const itemId = str(e["itemId"]);
		const item = itemId ? { itemId, itemTitle: context.items.get(itemId)?.title ?? "an item" } : {};
		const entry = str(e["entryId"]) ? context.entries.get(str(e["entryId"])!) : undefined;
		const invoiceId = str(e["invoiceId"]);
		const invoice = invoiceId ? context.invoices.get(invoiceId) : undefined;
		const push = (
			userId: UserId | undefined | null,
			type: NotificationType,
			payload: NotificationPayload,
		) => {
			if (userId) drafts.push({ userId, type, dedupeKey, payload: { ...base, ...item, ...payload } });
		};
		switch (e["type"]) {
			case "entry_won":
				push(str(e["buyerId"]), e["via"] === "promotion" ? "claim_promoted" : "claim_won", {
					amountCents: num(e["amountCents"]),
					kind: entry?.kind ?? "claim",
				});
				break;
			case "counter_sent":
				push(entry?.buyerId, "offer_countered", {
					amountCents: num(e["amountCents"]),
					expiresAt: num(e["expiresAt"]),
				});
				break;
			case "entry_ended":
				if (e["status"] === "declined") push(entry?.buyerId, "offer_declined", {});
				break;
			case "winner_removed":
				if (e["by"] === "seller")
					push(str(e["buyerId"]), "win_rescinded", { reasonCode: str(e["reasonCode"]) });
				break;
			case "entry_placed":
				if (entry) push(sale.sellerId, entry.kind === "offer" ? "seller_new_offer" : "seller_new_claim", {});
				break;
			case "entry_reopened":
				push(sale.sellerId, "seller_decision_needed", { reason: "counter_accepted" });
				break;
			case "seller_notified":
				// New claims and offers are told by entry_placed; this one has no entry of its own.
				if (e["reason"] === "backup_below_asking")
					push(sale.sellerId, "seller_decision_needed", { reason: "backup_below_asking" });
				break;
			case "takeback_requested":
				push(sale.sellerId, "seller_takeback_requested", {});
				break;
			case "invoice_sent":
				push(invoice?.buyerId, "invoice_sent", {
					invoiceId,
					totalCents: invoice?.totalCents ?? null,
					dueAt: num(e["dueAt"]),
				});
				break;
			case "invoice_overdue":
				push(invoice?.buyerId, "invoice_overdue", { invoiceId });
				break;
			case "payment_not_received":
				push(invoice?.buyerId, "payment_not_received", { invoiceId });
				break;
			case "payment_confirmed":
				push(invoice?.buyerId, "payment_confirmed", { invoiceId });
				break;
			case "invoice_shipped":
				push(invoice?.buyerId, "invoice_shipped", { invoiceId });
				break;
			case "buyer_marked_paid":
				push(sale.sellerId, "seller_buyer_paid", { invoiceId, totalCents: invoice?.totalCents ?? null });
				break;
			case "followers_notified":
				followers = types.has("sale_live") ? "live" : "scheduled";
				break;
			case "sale_scheduled":
			case "sale_live":
				published = true;
				break;
			default:
				break;
		}
	});
	return {
		drafts,
		followUps: {
			followers: sale.visibility === "public" ? followers : null,
			matchWantLists: published && sale.visibility === "public",
			sendInvites: published && sale.visibility === "private",
		},
	};
}

/**
 * A followed seller's new sale. Followers of a public sale only: unlisted and private sales
 * are shared by their seller, never announced (D5, D56).
 *
 * @spec SM-2-go-live-alarm — every follower gets one notification per phase (scheduled, live).
 */
export function followerNotifications(
	sale: SaleEventContext["sale"] & { readonly sellerName: string },
	followerIds: readonly UserId[],
	phase: "scheduled" | "live",
): NotificationDraft[] {
	return followerIds
		.filter((id) => id !== sale.sellerId)
		.map((userId) => ({
			userId,
			type: phase === "live" ? "followed_sale_live" : "followed_sale_scheduled",
			dedupeKey: `follow:${sale.id}:${phase}:${userId}`,
			payload: {
				saleId: sale.id,
				saleSlug: sale.slug,
				saleTitle: sale.title,
				sellerName: sale.sellerName,
				liveAt: sale.liveAt,
			},
		}));
}

// ---------------------------------------------------------------------------
// Want lists (D61)

export interface WantListEntry {
	readonly id: string;
	readonly userId: UserId;
	readonly productId: number;
	readonly finish: string | null;
	readonly maxPriceCents: number | null;
	readonly minCondition: string | null;
	readonly language: string | null;
}

export interface Listing {
	readonly itemId: string;
	readonly title: string;
	readonly catalogProductId: string | null;
	readonly kind: string;
	readonly finish: string | null;
	readonly condition: string | null;
	readonly language: string | null;
	readonly priceCents: number;
}

const isCondition = (value: string | null): value is Condition =>
	value !== null && (CONDITIONS as readonly string[]).includes(value);

/**
 * Whether a listing satisfies a want-list entry. A blank want field matches anything; an item
 * with no language is English; sealed product has no condition, so it passes a condition minimum.
 *
 * @spec TCG-want-list-notify — product, finish, condition ≥ minimum, price ≤ maximum (and language).
 */
export function matchesWant(want: WantListEntry, listing: Listing): boolean {
	if (listing.catalogProductId !== String(want.productId)) return false;
	if (want.finish !== null && listing.finish !== want.finish) return false;
	if (want.language !== null && (listing.language ?? "en") !== want.language) return false;
	if (want.maxPriceCents !== null && listing.priceCents > want.maxPriceCents) return false;
	if (want.minCondition !== null && isCondition(want.minCondition) && listing.kind !== "sealed") {
		if (!isCondition(listing.condition) || !conditionAtLeast(listing.condition, want.minCondition))
			return false;
	}
	return true;
}

/**
 * Want-list notifications for a public sale's listings. The key is the want-list entry and the
 * item, so its owner is told once, however often the sale is re-checked.
 *
 * @spec TCG-want-list-notify — each match notifies its owner once; never the seller about their own sale.
 */
export function wantListNotifications(
	sale: SaleEventContext["sale"],
	wants: readonly WantListEntry[],
	listings: readonly Listing[],
): NotificationDraft[] {
	const drafts: NotificationDraft[] = [];
	for (const want of wants) {
		if (want.userId === sale.sellerId) continue;
		for (const listing of listings) {
			if (!matchesWant(want, listing)) continue;
			drafts.push({
				userId: want.userId,
				type: "want_list_match",
				dedupeKey: `want:${want.id}:${listing.itemId}`,
				payload: {
					saleId: sale.id,
					saleSlug: sale.slug,
					saleTitle: sale.title,
					itemId: listing.itemId,
					itemTitle: listing.title,
					priceCents: listing.priceCents,
					liveAt: sale.liveAt,
				},
			});
		}
	}
	return drafts;
}

// ---------------------------------------------------------------------------
// Copy

export interface NotificationCopy {
	/** One line: the bell list's title and the email subject. */
	readonly title: string;
	readonly body: string;
	/** A site-relative link. */
	readonly path: string;
	readonly action: string;
}

const text = (payload: NotificationPayload, key: string, fallback = ""): string => {
	const value = payload[key];
	return typeof value === "string" ? value : fallback;
};
const money = (payload: NotificationPayload, key: string): string => {
	const value = payload[key];
	return typeof value === "number" ? formatCents(value) : "";
};
const quoted = (value: string) => `“${value}”`;

/** The copy of a stored row: its type may be from newer code, its payload is JSON. */
export function describeStoredNotification(type: string, payload: unknown): NotificationCopy {
	return isNotificationType(type)
		? describeNotification(type, parseNotificationPayload(payload))
		: {
				title: "ClaimSale update",
				body: "You have a new notification.",
				path: "/me/notifications",
				action: "Open",
			};
}

/** What a notification says. Invoice links go to the sale until the buyer's invoice page exists (WS-J). */
export function describeNotification(type: NotificationType, payload: NotificationPayload): NotificationCopy {
	const sale = quoted(text(payload, "saleTitle", "a sale"));
	const item = quoted(text(payload, "itemTitle", "an item"));
	const salePath = `/s/${text(payload, "saleSlug")}`;
	const itemPath = payload["itemId"] ? `${salePath}/i/${text(payload, "itemId")}` : salePath;
	const sellerPath = `/sell/${text(payload, "saleId")}`;
	switch (type) {
		case "claim_won":
			return {
				title: `You won ${item}`,
				body: `${payload["kind"] === "offer" ? "Your offer" : "Your claim"} on ${item} in ${sale} won${typeof payload["amountCents"] !== "number" ? "" : ` at ${money(payload, "amountCents")}`}. The seller sends an invoice after the sale closes.`,
				path: itemPath,
				action: "View the item",
			};
		case "claim_promoted":
			return {
				title: `You were promoted: ${item} is yours`,
				body: `A unit of ${item} in ${sale} passed to you from the backup queue${typeof payload["amountCents"] !== "number" ? "" : ` at ${money(payload, "amountCents")}`}.`,
				path: itemPath,
				action: "View the item",
			};
		case "offer_countered":
			return {
				title: `Counter offer on ${item}`,
				body: `The seller countered your offer on ${item} in ${sale} with ${money(payload, "amountCents")}. Answer within 24 hours.`,
				path: itemPath,
				action: "Answer the counter",
			};
		case "offer_declined":
			return {
				title: `Offer declined on ${item}`,
				body: `Your offer on ${item} in ${sale} was declined.`,
				path: itemPath,
				action: "View the item",
			};
		case "win_rescinded":
			return {
				title: `The seller rescinded your win on ${item}`,
				body: `The seller of ${sale} rescinded your win on ${item}. You can see the reason on the sale.`,
				path: itemPath,
				action: "View the item",
			};
		case "invoice_sent":
			return {
				title: `Invoice from ${sale}`,
				body: `Your invoice${typeof payload["totalCents"] !== "number" ? "" : ` for ${money(payload, "totalCents")}`} is ready. Pick shipping and pay the seller before the deadline.`,
				path: salePath,
				action: "View the invoice",
			};
		case "invoice_overdue":
			return {
				title: `Your invoice from ${sale} is overdue`,
				body: `The payment deadline passed. Pay now or message the seller, or the seller may rescind your wins.`,
				path: salePath,
				action: "View the invoice",
			};
		case "payment_not_received":
			return {
				title: `The seller hasn't received your payment for ${sale}`,
				body: `The seller marked your payment as not received. Check the payment and message the seller.`,
				path: salePath,
				action: "View the invoice",
			};
		case "payment_confirmed":
			return {
				title: `Payment confirmed for ${sale}`,
				body: `The seller confirmed your payment. You'll hear from us when it ships.`,
				path: salePath,
				action: "View the invoice",
			};
		case "invoice_shipped":
			return {
				title: `Your order from ${sale} shipped`,
				body: `The seller marked your order as shipped. Confirm when it arrives.`,
				path: salePath,
				action: "View the order",
			};
		case "seller_new_claim":
			return {
				title: `New claim on ${item}`,
				body: `Someone claimed ${item} in ${sale}.`,
				path: sellerPath,
				action: "Open the sale",
			};
		case "seller_new_offer":
			return {
				title: `New offer on ${item}`,
				body: `Someone made an offer on ${item} in ${sale}.`,
				path: sellerPath,
				action: "Review offers",
			};
		case "seller_decision_needed":
			return {
				title: `Decision needed on ${item}`,
				body:
					payload["reason"] === "counter_accepted"
						? `A buyer accepted your counter on ${item} in ${sale}.`
						: `The next backup on ${item} in ${sale} is below asking. Award it or pass.`,
				path: sellerPath,
				action: "Open the sale",
			};
		case "seller_buyer_paid":
			return {
				title: `A buyer says they paid for ${sale}`,
				body: `Check your payment app and confirm the payment${typeof payload["totalCents"] !== "number" ? "" : ` of ${money(payload, "totalCents")}`}.`,
				path: sellerPath,
				action: "Open the sale",
			};
		case "seller_takeback_requested":
			return {
				title: `Take-back request on ${item}`,
				body: `A buyer asked to give back ${item} in ${sale}. Approve or deny it.`,
				path: sellerPath,
				action: "Open the sale",
			};
		case "followed_sale_scheduled":
			return {
				title: `${text(payload, "sellerName", "A seller you follow")} scheduled a new sale`,
				body: `${sale}${typeof payload["liveAt"] === "number" ? ` goes live ${new Date(payload["liveAt"]).toUTCString()}` : " goes live soon"}.`,
				path: salePath,
				action: "Preview the sale",
			};
		case "followed_sale_live":
			return {
				title: `${sale} is live`,
				body: `${text(payload, "sellerName", "A seller you follow")}'s sale is open for claims now.`,
				path: salePath,
				action: "Shop the sale",
			};
		case "want_list_match":
			return {
				title: `Want list match: ${item}`,
				body: `${item} is listed for ${money(payload, "priceCents")} in ${sale}.`,
				path: itemPath,
				action: "View the listing",
			};
		case "new_message":
			return {
				title: `New message from ${text(payload, "senderName", "someone")}`,
				body: `You have an unread message about ${sale}.`,
				path: `/me/messages/${text(payload, "conversationId")}`,
				action: "Read it",
			};
		default:
			// A type written by newer code than this (rows outlive deploys).
			return {
				title: "ClaimSale update",
				body: "You have a new notification.",
				path: "/me/notifications",
				action: "Open",
			};
	}
}

/**
 * One email for a seller's batched activity: counts per kind, newest sales first.
 *
 * @spec NOTIF-seller-batch — "12 new claims in the last 5 minutes" instead of an email per claim.
 */
export function sellerDigest(rows: ReadonlyArray<{ type: NotificationType; payload: NotificationPayload }>): {
	subject: string;
	lines: string[];
	path: string;
} {
	const bySale = new Map<string, { title: string; saleId: string; counts: Map<NotificationType, number> }>();
	for (const row of rows) {
		const saleId = text(row.payload, "saleId");
		const entry = bySale.get(saleId) ?? {
			title: text(row.payload, "saleTitle", "your sale"),
			saleId,
			counts: new Map(),
		};
		entry.counts.set(row.type, (entry.counts.get(row.type) ?? 0) + 1);
		bySale.set(saleId, entry);
	}
	const lines: string[] = [];
	for (const sale of bySale.values()) {
		const parts = [...sale.counts].map(([type, n]) => digestPhrase(type, n));
		lines.push(`${quoted(sale.title)}: ${parts.join(", ")}`);
	}
	const claims = rows.filter((r) => r.type === "seller_new_claim").length;
	const subject =
		rows.length === claims
			? `${claims} new ${claims === 1 ? "claim" : "claims"} in the last few minutes`
			: `${rows.length} updates on your ${bySale.size === 1 ? "sale" : "sales"}`;
	const only = bySale.size === 1 ? [...bySale.values()][0] : undefined;
	return { subject, lines, path: only ? `/sell/${only.saleId}` : "/sell" };
}

function digestPhrase(type: NotificationType, n: number): string {
	const plural = (one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	switch (type) {
		case "seller_new_claim":
			return plural("new claim", "new claims");
		case "seller_new_offer":
			return plural("new offer", "new offers");
		case "seller_decision_needed":
			return plural("decision needed", "decisions needed");
		case "seller_buyer_paid":
			return plural("payment to confirm", "payments to confirm");
		case "seller_takeback_requested":
			return plural("take-back request", "take-back requests");
		default:
			return plural("update", "updates");
	}
}
