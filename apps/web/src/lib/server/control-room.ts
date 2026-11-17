import {
	buyerRecord,
	compareRank,
	fromStored,
	isRescindReasonCode,
	reject,
	type Entry,
	type EntryStatus,
	type Rejection,
	type Rescind,
	type Result,
} from "@claimsale/core";
import { and, asc, eq, inArray, ne, sql, type Db } from "@claimsale/db";
import {
	entries,
	invoiceLines,
	invoices,
	items,
	rescinds,
	takebackRequests,
	users,
} from "@claimsale/db/schema";
import type { Outcome, RpcResult } from "@claimsale/engine";
import type {
	BuyerSummary,
	ControlItem,
	ControlRoom,
	PendingTakeback,
	QueueEntry,
	SaleRescind,
} from "#lib/control-room.ts";
import { parsePrice } from "#lib/listing-input.ts";
import { field } from "./forms.ts";

/**
 * The seller control room (`/sell/[saleId]/manage`, PLAN §7): reads come straight from
 * D1; every write goes through the sale's engine (STATE_MACHINES §9) with the
 * authenticated seller's ID, and the engine checks the rules and the §8 matrix.
 */

const ACTIVE: readonly EntryStatus[] = ["open", "countered", "won"];

type EntryRow = typeof entries.$inferSelect;

function toEntry(row: EntryRow): Entry {
	return {
		id: row.id,
		buyerId: row.userId,
		kind: row.kind,
		amountCents: row.amountCents,
		status: row.status,
		createdAt: row.createdAt,
		rankOverride: row.rankOverride,
		counterCents: row.counterCents,
		counterExpiresAt: row.counterExpiresAt,
		wonAt: row.wonAt,
		endedAt: row.endedAt,
		endedReason: null,
		endedBy: row.endedBy,
	};
}

const queueEntry = (entry: Entry, invoiceStatus: string | null): QueueEntry => ({
	id: entry.id,
	buyerId: entry.buyerId,
	kind: entry.kind,
	amountCents: entry.amountCents,
	status: entry.status,
	createdAt: entry.createdAt,
	counterCents: entry.counterCents,
	counterExpiresAt: entry.counterExpiresAt,
	wonAt: entry.wonAt,
	invoiceStatus,
});

const storedRescind = (row: typeof rescinds.$inferSelect): Rescind | null =>
	fromStored({
		reasonCode: row.reasonCode,
		phase: row.phase,
		refundOwed: row.refundOwed,
		createdAt: row.createdAt,
		contestedAt: row.contestedAt,
		resolvedFault: row.resolvedFault,
		resolvedAt: row.resolvedAt,
	});

const count = (rows: ReadonlyArray<{ id: string; n: number }>, id: string) =>
	rows.find((r) => r.id === id)?.n ?? 0;

/**
 * The records of the given buyers (PLAN §3b): handle, display name and their counts.
 *
 * @spec REP-buyer-record — only final rescinds count, by their resolved fault.
 */
export async function buyerSummaries(
	db: Db,
	userIds: readonly string[],
): Promise<Record<string, BuyerSummary>> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return {};
	const [people, completed, takebacks, proRescinds, rescindRows] = await Promise.all([
		db
			.select({
				id: users.id,
				handle: users.handle,
				displayName: users.displayName,
				createdAt: users.createdAt,
			})
			.from(users)
			.where(inArray(users.id, ids))
			.all(),
		db
			.select({ id: invoices.buyerId, n: sql<number>`count(*)` })
			.from(invoices)
			.where(and(inArray(invoices.buyerId, ids), eq(invoices.status, "completed")))
			.groupBy(invoices.buyerId)
			.all(),
		db
			.select({ id: takebackRequests.buyerId, n: sql<number>`count(*)` })
			.from(takebackRequests)
			.where(and(inArray(takebackRequests.buyerId, ids), eq(takebackRequests.status, "approved")))
			.groupBy(takebackRequests.buyerId)
			.all(),
		db
			.select({ id: entries.userId, n: sql<number>`count(*)` })
			.from(entries)
			.where(and(inArray(entries.userId, ids), eq(entries.endedReason, "buyer_rescind")))
			.groupBy(entries.userId)
			.all(),
		db.select().from(rescinds).where(inArray(rescinds.buyerId, ids)).all(),
	]);
	const out: Record<string, BuyerSummary> = {};
	for (const person of people) {
		out[person.id] = {
			id: person.id,
			handle: person.handle,
			displayName: person.displayName,
			record: buyerRecord({
				rescinds: rescindRows.filter((r) => r.buyerId === person.id).flatMap((r) => storedRescind(r) ?? []),
				completedPurchases: count(completed, person.id),
				approvedTakebacks: count(takebacks, person.id),
				proRescinds: count(proRescinds, person.id),
				memberSince: person.createdAt.getTime(),
			}),
		};
	}
	return out;
}

/** Everything the control room shows for one of the seller's sales. */
export async function loadControlRoom(db: Db, saleId: string): Promise<ControlRoom> {
	const itemRows = await db
		.select({
			id: items.id,
			title: items.title,
			priceCents: items.priceCents,
			quantity: items.quantity,
			state: items.state,
			decisionDeadline: items.decisionDeadline,
			offersLapseAt: items.offersLapseAt,
		})
		.from(items)
		.where(eq(items.saleId, saleId))
		.orderBy(asc(items.sortOrder), asc(items.id))
		.all();
	const itemIds = itemRows.map((i) => i.id);
	const titles = new Map(itemRows.map((i) => [i.id, i.title]));
	if (itemIds.length === 0) return { items: [], buyers: {}, takebacks: [], rescinds: [] };

	const [entryRows, lineRows, takebackRows, rescindRows] = await Promise.all([
		db
			.select()
			.from(entries)
			.where(and(inArray(entries.itemId, itemIds), inArray(entries.status, [...ACTIVE])))
			.all(),
		db
			.select({ entryId: invoiceLines.entryId, status: invoices.status })
			.from(invoiceLines)
			.innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
			.where(and(eq(invoices.saleId, saleId), ne(invoices.status, "cancelled")))
			.all(),
		db
			.select({
				id: takebackRequests.id,
				entryId: takebackRequests.entryId,
				itemId: entries.itemId,
				buyerId: takebackRequests.buyerId,
				reason: takebackRequests.reason,
				createdAt: takebackRequests.createdAt,
			})
			.from(takebackRequests)
			.innerJoin(entries, eq(entries.id, takebackRequests.entryId))
			.where(and(inArray(entries.itemId, itemIds), eq(takebackRequests.status, "pending")))
			.orderBy(asc(takebackRequests.createdAt))
			.all(),
		db
			.select({ rescind: rescinds, itemId: entries.itemId })
			.from(rescinds)
			.innerJoin(entries, eq(entries.id, rescinds.entryId))
			.where(inArray(entries.itemId, itemIds))
			.orderBy(asc(rescinds.createdAt), asc(rescinds.id))
			.all(),
	]);

	const invoiceOf = new Map(lineRows.map((l) => [l.entryId, l.status]));
	const view = (e: Entry) => queueEntry(e, invoiceOf.get(e.id) ?? null);
	const controlItems: ControlItem[] = itemRows.map((item) => {
		const mine = entryRows.filter((e) => e.itemId === item.id).map(toEntry);

		return {
			...item,
			winners: mine
				.filter((e) => e.status === "won")
				.toSorted((a, b) => (a.wonAt ?? 0) - (b.wonAt ?? 0))
				.map(view),
			queue: mine
				.filter((e) => e.status === "open")
				.toSorted(compareRank)
				.map(view),
			countered: mine.filter((e) => e.status === "countered").map(view),
		};
	});

	const takebacks: PendingTakeback[] = takebackRows.map((t) => ({
		...t,
		itemTitle: titles.get(t.itemId) ?? "",
	}));
	const saleRescinds: SaleRescind[] = rescindRows.flatMap(({ rescind: row, itemId }) => {
		const rescind = storedRescind(row);
		if (!rescind) return [];
		return [
			{
				id: row.id,
				entryId: row.entryId,
				itemTitle: titles.get(itemId) ?? "",
				buyerId: row.buyerId,
				reasonCode: rescind.reasonCode,
				explanation: row.explanation,
				phase: rescind.phase,
				refundOwed: rescind.refundOwed,
				createdAt: row.createdAt,
				resolvedFault: rescind.resolvedFault,
			},
		];
	});
	const buyerIds = [
		...entryRows.map((e) => e.userId),
		...takebacks.map((t) => t.buyerId),
		...saleRescinds.map((r) => r.buyerId),
	];
	return {
		items: controlItems,
		buyers: await buyerSummaries(db, buyerIds),
		takebacks,
		rescinds: saleRescinds,
	};
}

// ---------------------------------------------------------------------------
// Actions

/** The engine RPC methods the control room calls (the ENGINE service binding has them all). */
export type ControlRoomEngine = Pick<
	Env["ENGINE"],
	| "awardEntry"
	| "declineOffer"
	| "counterOffer"
	| "reorderBackups"
	| "sellerRescind"
	| "decideTakeback"
	| "withdrawItem"
>;

export const CONTROL_ACTIONS = [
	"award",
	"decline",
	"counter",
	"moveBackup",
	"rescind",
	"approveTakeback",
	"denyTakeback",
	"withdrawItem",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export type ActionOutcome = Result<string, Rejection>;

const unavailable = () =>
	reject("engine_unavailable", "The sale engine didn't answer. Try again in a moment.");

/** The engine's answer: a defect becomes a retryable rejection; a rule's "no" stays as it is. */
async function settle(call: Promise<unknown>, done: string): Promise<ActionOutcome> {
	let result: RpcResult<Outcome<unknown>>;
	try {
		// The binding's methods all answer RpcResult<Outcome<…>> (apps/engine/src/index.ts).
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		result = (await call) as RpcResult<Outcome<unknown>>;
	} catch {
		return unavailable();
	}
	if (!result.ok) return unavailable();
	return result.value.ok ? { ok: true, value: done } : result.value;
}

const missing = (what: string) => reject("invalid_input", `Pick ${what}`);

/**
 * Runs one control-room form action through the engine. `sellerId` is the
 * authenticated seller; the engine re-checks that the sale is theirs (§8).
 */
export async function runControlAction(
	db: Db,
	engine: ControlRoomEngine,
	ctx: { readonly saleId: string; readonly sellerId: string },
	action: ControlAction,
	data: FormData,
): Promise<ActionOutcome> {
	const { saleId, sellerId } = ctx;
	const itemId = field(data, "itemId");
	const entryId = field(data, "entryId");
	switch (action) {
		case "award":
			if (!itemId || !entryId) return missing("an entry");
			return settle(engine.awardEntry({ saleId, itemId, entryId, sellerId }), "Awarded.");
		case "decline":
			if (!itemId || !entryId) return missing("an offer");
			return settle(engine.declineOffer({ saleId, itemId, entryId, sellerId }), "Offer declined.");
		case "counter": {
			if (!itemId || !entryId) return missing("an offer");
			const amount = parsePrice(field(data, "amount"));
			if (!amount.ok) return reject("invalid_amount", amount.message);
			return settle(
				engine.counterOffer({ saleId, itemId, entryId, sellerId, amountCents: amount.value }),
				"Counter sent. The buyer has 24 hours to answer.",
			);
		}
		case "moveBackup": {
			if (!itemId || !entryId) return missing("a backup");
			const order = await moveInQueue(db, itemId, entryId, field(data, "direction") === "down" ? 1 : -1);
			if (!order) return reject("invalid_input", "That entry isn't in the queue any more");
			return settle(
				engine.reorderBackups({ saleId, itemId, sellerId, orderedEntryIds: order }),
				"Queue reordered.",
			);
		}
		case "rescind": {
			if (!itemId || !entryId) return missing("a winner");
			const reasonCode = field(data, "reasonCode");
			if (!isRescindReasonCode(reasonCode)) return missing("a reason");
			return settle(
				// The engine checks the explanation and the paid-invoice confirmation (SM-4.3-seller-rescind).
				engine.sellerRescind({
					saleId,
					itemId,
					entryId,
					sellerId,
					reasonCode,
					explanation: field(data, "explanation"),
					passToNext: data.get("passToNext") === "on",
					confirmed: data.get("confirmed") === "on",
				}),
				data.get("passToNext") === "on" ? "Rescinded and passed to the next in line." : "Rescinded.",
			);
		}
		case "approveTakeback":
		case "denyTakeback": {
			const requestId = field(data, "requestId");
			if (!requestId) return missing("a take-back request");
			const approve = action === "approveTakeback";
			return settle(
				engine.decideTakeback({ saleId, requestId, sellerId, approve }),
				approve
					? "Take-back approved; the next in line was promoted."
					: "Take-back denied; the claim stands.",
			);
		}
		case "withdrawItem":
		default:
			if (!itemId) return missing("an item");
			return settle(engine.withdrawItem({ saleId, itemId, sellerId }), "Item withdrawn.");
	}
}

/**
 * The item's open entries in rank order with one moved up (-1) or down (+1), or null
 * if it isn't open. The engine stores the order as the seller's override (D44).
 *
 * @spec SM-4.2-ranking — the seller overrides the default rank order.
 */
export async function moveInQueue(
	db: Db,
	itemId: string,
	entryId: string,
	delta: -1 | 1,
): Promise<string[] | null> {
	const rows = await db
		.select()
		.from(entries)
		.where(and(eq(entries.itemId, itemId), eq(entries.status, "open")))
		.all();
	const order = rows
		.map(toEntry)
		.toSorted(compareRank)
		.map((e) => e.id);
	const at = order.indexOf(entryId);
	if (at === -1) return null;
	const to = Math.min(order.length - 1, Math.max(0, at + delta));
	const [moved] = order.splice(at, 1);
	order.splice(to, 0, moved!);
	return order;
}
