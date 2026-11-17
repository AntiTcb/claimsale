import {
	addWin,
	award as awardEntry,
	buyerRescind as coreBuyerRescind,
	can,
	cancelTakeback as coreCancelTakeback,
	close as closeSale,
	closeItem,
	complete as completeInvoice,
	confirmPaid as coreConfirmPaid,
	counter as counterOffer,
	createRescind,
	decideTakeback as coreDecideTakeback,
	declineOffer as coreDeclineOffer,
	deriveItemState,
	expireCounter,
	expireDecisionWindow,
	FREE_ACTIVE_SALE_CAP,
	freeUnits,
	fulfill,
	goLive as goLiveSale,
	lapseOffersAfterClose,
	loseBackups,
	markBuyerPaid as coreMarkBuyerPaid,
	markOverdue,
	ok,
	paymentNotReceived as corePaymentNotReceived,
	place as placeEntry,
	publish as publishSale,
	reject,
	releaseForTakeback,
	removeLine,
	reorder as coreReorder,
	requestTakeback as coreRequestTakeback,
	respondToCounter as coreRespondToCounter,
	send as sendInvoice,
	sellerRescind as coreSellerRescind,
	ship as shipInvoice,
	unpublish as unpublishSale,
	withdraw as withdrawEntry,
	withdrawItem as coreWithdrawItem,
	type Action,
	type Actor,
	type Cents,
	type Entry,
	type EntryKind,
	type Invoice,
	type InvoiceEvent,
	type InvoiceRejection,
	type InvoiceTransition,
	type Item,
	type ItemContext,
	type ItemEvent,
	type ItemResult,
	type ItemState,
	type Millis,
	type Rejection,
	type RescindReasonCode,
	type Result,
	type SaleStatus,
	type Tier,
	type Timer,
} from "@claimsale/core";
import { planImportBatch, type ImportBatchInput, type ImportBatchResult } from "./import.ts";
import { itemKey, KeyedLocks, lockOrder, type LockKey } from "./locks.ts";
import { toTakeback, type TakebackRow } from "./rows.ts";
import {
	loadInvoices,
	loadSale,
	loadSaleAndItems,
	loadTier,
	newId,
	Work,
	WriteConflict,
	type SaleRecord,
} from "./store.ts";

/**
 * The SaleEngine's write path (STATE_MACHINES §9): every command takes its locks,
 * loads what it needs from D1, runs the pure transition from `@claimsale/core`, and
 * commits one batch with version checks and an audit row. Domain rules live in core;
 * this file only orchestrates.
 *
 * @spec SM-9-serialized-writes — per-item locks plus a version check on every item write.
 * @spec SM-9-audit — every committed command writes its audit row in the same batch.
 */

export type Outcome<A> = Result<A, Rejection>;

export interface ItemView {
	readonly id: string;
	readonly state: ItemState;
	readonly freeUnits: number;
	readonly decisionDeadline: Millis | null;
	readonly version: number;
}

export interface ItemCommandResult {
	readonly item: ItemView;
	/** The entry the command acted on, after the command. */
	readonly entry: Entry | null;
	readonly events: readonly ItemEvent[];
}

export interface SaleView {
	readonly status: SaleStatus;
	readonly liveAt: Millis | null;
	readonly closesAt: Millis | null;
}

export interface InvoiceView extends Invoice {
	readonly saleId: string;
}

/** Called after each successful commit: re-arm the alarm, publish the events. */
export type AfterCommit = (work: Work) => Promise<void>;

const MAX_ATTEMPTS = 3;
const notFound = (what = "sale") => reject("not_found", `No such ${what}`);
const notAllowed = () => reject("not_allowed", "You can't do that");
const conflict = () => reject("conflict", "Something changed at the same time. Try again.");

type Body<A> = (session: LockSession, now: Millis) => Promise<Outcome<{ work: Work; value: A }>>;

/** The locks one command holds. Later keys must sort after the ones already held. */
class LockSession {
	readonly #held = new Set<LockKey>();
	readonly #releases: Array<() => void> = [];
	constructor(readonly locks: KeyedLocks) {}

	async take(keys: Iterable<LockKey>): Promise<void> {
		const fresh = [...new Set(keys)].filter((k) => !this.#held.has(k)).toSorted(lockOrder);
		if (fresh.length === 0) return;
		const last = [...this.#held].toSorted(lockOrder).at(-1);
		if (last !== undefined && lockOrder(fresh[0]!, last) < 0) {
			throw new Error(`lock order violated: ${fresh[0]} after ${last}`);
		}
		this.#releases.push(await this.locks.acquire(fresh));
		for (const key of fresh) this.#held.add(key);
	}

	release(): void {
		for (const release of this.#releases.toReversed()) release();
		this.#releases.length = 0;
		this.#held.clear();
	}
}

export function itemContext(sale: SaleRecord, saleStatus: SaleStatus): ItemContext {
	return {
		saleStatus,
		sellerId: sale.sellerId,
		sellerTier: sale.sellerTier,
		reviewEveryClaim: sale.settings.reviewEveryClaim,
		allowBackupOffers: sale.settings.allowBackupOffers,
		decisionWindow: sale.settings.decisionWindow,
		buyerRequirements: sale.settings.buyerRequirements,
	};
}

const sellerActor = (sale: SaleRecord): Actor => ({ kind: "seller", id: sale.sellerId, tier: sale.sellerTier });
const SYSTEM: Actor = { kind: "system" };

/** The actor for a user acting on this sale: its seller, or a buyer. */
function actorFor(sale: SaleRecord, userId: string, buyerTier: Tier = "free"): Actor {
	return userId === sale.sellerId ? sellerActor(sale) : { kind: "buyer", id: userId, tier: buyerTier };
}

/** @spec SM-8-permissions — every command checks the section 8 matrix before its transition. */
function permitted(actor: Actor, action: Action): boolean {
	return can(actor, action);
}

export interface PlaceInput {
	readonly itemId: string;
	readonly buyerId: string;
	readonly kind: EntryKind;
	readonly amountCents?: Cents;
}

export interface SellerRescindInput {
	readonly itemId: string;
	readonly entryId: string;
	readonly sellerId: string;
	readonly reasonCode: RescindReasonCode;
	readonly explanation: string;
	readonly passToNext: boolean;
	readonly confirmed: boolean;
	readonly attachmentKey?: string | null;
}

export interface PublishInput {
	readonly sellerId: string;
	readonly liveAt: Millis | null;
	readonly closesAt: Millis;
}

export class SaleWriter {
	constructor(
		readonly db: D1Database,
		readonly saleId: string,
		readonly locks: KeyedLocks,
		readonly clock: () => Millis,
		readonly afterCommit: AfterCommit,
	) {}

	// -------------------------------------------------------------------------
	// Plumbing

	/** Runs a command under its locks, retrying when a version check fails. */
	async #transact<A>(keys: readonly LockKey[], body: Body<A>): Promise<Outcome<A>> {
		for (let attempt = 1; ; attempt++) {
			const session = new LockSession(this.locks);
			try {
				await session.take(keys);
				const now = this.clock();
				const result = await body(session, now);
				if (!result.ok) return result;
				await result.value.work.commit();
				session.release();
				await this.afterCommit(result.value.work);
				return ok(result.value.value);
			} catch (error) {
				if (!(error instanceof WriteConflict)) throw error;
				if (attempt >= MAX_ATTEMPTS) return conflict();
			} finally {
				session.release();
			}
		}
	}

	/** Takes the invoices lock (sorted last) and loads the sale's invoices into the work. */
	async #withInvoices(session: LockSession, work: Work): Promise<void> {
		if (work.invoices) return;
		await session.take(["invoices"]);
		work.invoices = await loadInvoices(this.db, this.saleId, work.sale.sellerTier);
	}

	async #loadItem(itemId: string, now: Millis, buyer?: { id: string }) {
		const loaded = await loadSaleAndItems(this.db, this.saleId, [itemId], now, buyer);
		if (!loaded.sale) return { missing: notFound() } as const;
		const item = loaded.items.get(itemId);
		if (!item) return { missing: notFound("item") } as const;
		const work = new Work(this.db, loaded.sale, now);
		work.addItems(loaded.items);
		return { sale: loaded.sale, work, item: item.item, buyer: loaded.buyer } as const;
	}

	#itemResult(work: Work, itemId: string, entryId: string | null, events: readonly ItemEvent[]): ItemCommandResult {
		const slot = work.items.get(itemId)!;
		const item = slot.after;
		const changed = work.changedItemIds().includes(itemId);
		return {
			item: {
				id: itemId,
				state: deriveItemState(item, work.saleStatus),
				freeUnits: freeUnits(item),
				decisionDeadline: item.decisionDeadline,
				version: slot.before.version + (changed ? 1 : 0),
			},
			entry: entryId === null ? null : (item.entries.find((e) => e.id === entryId) ?? null),
			events,
		};
	}

	/**
	 * Applies an item transition: the new item, its invoice effects (wins become lines,
	 * removed winners leave them) and the events to publish.
	 */
	async #applyItem(
		session: LockSession,
		work: Work,
		itemId: string,
		result: { item: Item; events: readonly ItemEvent[] },
		refundDue: ReadonlyMap<string, boolean> = new Map(),
	): Promise<Outcome<InvoiceEvent[]>> {
		work.setItem(result.item);
		for (const event of result.events) work.event({ ...event, itemId });
		const invoiceEvents: InvoiceEvent[] = [];
		const needsInvoices = result.events.some((e) => e.type === "entry_won" || e.type === "winner_removed");
		if (!needsInvoices) return ok(invoiceEvents);
		await this.#withInvoices(session, work);
		for (const event of result.events) {
			if (event.type === "entry_won") {
				const added = addWin(
					work.allInvoices(),
					event.buyerId,
					work.sale.sellerId,
					work.sale.sellerTier,
					{ entryId: event.entryId, description: work.title(itemId), amountCents: event.amountCents },
					newId(),
				);
				if (!added.ok) return added;
				work.setInvoice(added.value.invoice);
				invoiceEvents.push(...added.value.events);
			} else if (event.type === "winner_removed") {
				const invoice = work.invoiceFor(event.entryId);
				if (invoice) {
					const removed = removeLine(invoice, event.entryId, refundDue.get(event.entryId) ?? false);
					if (!removed.ok) return removed;
					work.setInvoice(removed.value.invoice);
					invoiceEvents.push(...removed.value.events);
				}
				// SM-5: a pending take-back ends when the entry ends some other way.
				if (event.by !== "takeback") {
					work.extra.push(
						this.db
							.prepare(
								"UPDATE takeback_requests SET status = 'cancelled', decided_at = ?1 WHERE entry_id = ?2 AND status = 'pending'",
							)
							.bind(work.now, event.entryId),
					);
				}
			}
		}
		for (const event of invoiceEvents) work.event({ ...event });
		return ok(invoiceEvents);
	}

	/** A seller-side item command: load, check the seller and the matrix, transition, apply. */
	async #sellerItemCommand(
		itemId: string,
		sellerId: string,
		action: Action,
		audit: { action: string; entryId: string | null; input?: Record<string, unknown> },
		transition: (item: Item, context: ItemContext, actor: Actor, now: Millis) => ItemResult,
	): Promise<Outcome<ItemCommandResult>> {
		return this.#transact([itemKey(itemId)], async (session, now) => {
			const loaded = await this.#loadItem(itemId, now);
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item } = loaded;
			if (sellerId !== sale.sellerId) return notAllowed();
			const actor = sellerActor(sale);
			if (!permitted(actor, action)) return notAllowed();
			const result = transition(item, itemContext(sale, sale.sale.status), actor, now);
			if (!result.ok) return result;
			const applied = await this.#applyItem(session, work, itemId, result.value);
			if (!applied.ok) return applied;
			work.audit({ action: audit.action, actorId: sellerId, itemId, input: audit.input, events: result.value.events });
			return ok({ work, value: this.#itemResult(work, itemId, audit.entryId, result.value.events) });
		});
	}

	/** A buyer-side item command on one of the buyer's own entries. */
	async #buyerItemCommand(
		itemId: string,
		buyerId: string,
		action: Action,
		audit: { action: string; entryId: string; input?: Record<string, unknown> },
		transition: (item: Item, actor: Actor, now: Millis) => ItemResult,
	): Promise<Outcome<ItemCommandResult>> {
		return this.#transact([itemKey(itemId)], async (session, now) => {
			const loaded = await this.#loadItem(itemId, now);
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item } = loaded;
			const actor = actorFor(sale, buyerId);
			if (!permitted(actor, action)) return notAllowed();
			const result = transition(item, actor, now);
			if (!result.ok) return result;
			const applied = await this.#applyItem(session, work, itemId, result.value);
			if (!applied.ok) return applied;
			work.audit({ action: audit.action, actorId: buyerId, itemId, input: audit.input, events: result.value.events });
			return ok({ work, value: this.#itemResult(work, itemId, audit.entryId, result.value.events) });
		});
	}

	// -------------------------------------------------------------------------
	// Entries (STATE_MACHINES §4)

	/** A buyer claims or offers (§4.1). */
	place(input: PlaceInput): Promise<Outcome<ItemCommandResult>> {
		return this.#transact([itemKey(input.itemId)], async (session, now) => {
			const loaded = await this.#loadItem(input.itemId, now, { id: input.buyerId });
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item, buyer } = loaded;
			if (!buyer) return notFound("buyer");
			const actor = actorFor(sale, buyer.id, buyer.tier);
			// The seller isn't a buyer in their own sale; core rejects that too.
			if (actor.kind === "buyer" && !permitted(actor, "place_entry")) return notAllowed();
			const entryId = newId();
			const result = placeEntry(
				item,
				itemContext(sale, sale.sale.status),
				buyer,
				{
					entryId,
					kind: input.kind,
					...(input.amountCents === undefined ? {} : { amountCents: input.amountCents }),
				},
				now,
			);
			if (!result.ok) return result;
			const applied = await this.#applyItem(session, work, input.itemId, result.value);
			if (!applied.ok) return applied;
			work.audit({
				action: "entry_placed",
				actorId: buyer.id,
				itemId: input.itemId,
				input: { entryId, kind: input.kind, amountCents: input.amountCents ?? null },
				events: result.value.events,
			});
			return ok({ work, value: this.#itemResult(work, input.itemId, entryId, result.value.events) });
		});
	}

	/** A buyer withdraws an offer or leaves the backup queue (§4.4). */
	withdraw(input: { itemId: string; entryId: string; buyerId: string }) {
		return this.#buyerItemCommand(
			input.itemId,
			input.buyerId,
			"withdraw_offer",
			{ action: "entry_withdrawn", entryId: input.entryId },
			(item, actor, now) => withdrawEntry(item, actor, input.entryId, now),
		);
	}

	/** The buyer answers a counter (§4.4). */
	respondToCounter(input: { itemId: string; entryId: string; buyerId: string; accept: boolean }) {
		return this.#buyerItemCommand(
			input.itemId,
			input.buyerId,
			"place_entry",
			{ action: input.accept ? "counter_accepted" : "counter_declined", entryId: input.entryId },
			(item, actor, now) => coreRespondToCounter(item, actor, input.entryId, input.accept, now),
		);
	}

	award(input: { itemId: string; entryId: string; sellerId: string }) {
		return this.#sellerItemCommand(
			input.itemId,
			input.sellerId,
			"award",
			{ action: "entry_awarded", entryId: input.entryId },
			(item, context, actor, now) => awardEntry(item, context, actor, input.entryId, now),
		);
	}

	declineOffer(input: { itemId: string; entryId: string; sellerId: string }) {
		return this.#sellerItemCommand(
			input.itemId,
			input.sellerId,
			"decline_offer",
			{ action: "offer_declined", entryId: input.entryId },
			(item, context, actor, now) => coreDeclineOffer(item, context, actor, input.entryId, now),
		);
	}

	counter(input: { itemId: string; entryId: string; sellerId: string; amountCents: Cents }) {
		return this.#sellerItemCommand(
			input.itemId,
			input.sellerId,
			"counter",
			{ action: "offer_countered", entryId: input.entryId, input: { amountCents: input.amountCents } },
			(item, context, actor, now) => counterOffer(item, context, actor, input.entryId, input.amountCents, now),
		);
	}

	reorder(input: { itemId: string; sellerId: string; orderedEntryIds: readonly string[] }) {
		return this.#sellerItemCommand(
			input.itemId,
			input.sellerId,
			"reorder_backups",
			{ action: "backups_reordered", entryId: null, input: { order: input.orderedEntryIds } },
			(item, context, actor) => coreReorder(item, context, actor, input.orderedEntryIds),
		);
	}

	withdrawItem(input: { itemId: string; sellerId: string }) {
		return this.#sellerItemCommand(
			input.itemId,
			input.sellerId,
			"rescind_and_pass",
			{ action: "item_withdrawn", entryId: null },
			(item, context, actor, now) => coreWithdrawItem(item, context, actor, now),
		);
	}

	// -------------------------------------------------------------------------
	// Removing a winner (§4.3, §5)

	/** The seller rescinds a win with a reason code (§4.3, §4.3.1). */
	sellerRescind(input: SellerRescindInput): Promise<Outcome<ItemCommandResult>> {
		return this.#transact([itemKey(input.itemId)], async (session, now) => {
			const loaded = await this.#loadItem(input.itemId, now);
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item } = loaded;
			if (input.sellerId !== sale.sellerId) return notAllowed();
			const actor = sellerActor(sale);
			if (!permitted(actor, "rescind_and_pass")) return notAllowed();
			return this.#rescind(session, work, item, actor, input, input.sellerId, now);
		});
	}

	async #rescind(
		session: LockSession,
		work: Work,
		item: Item,
		actor: Actor,
		input: Omit<SellerRescindInput, "sellerId">,
		auditActor: string,
		now: Millis,
	): Promise<Outcome<{ work: Work; value: ItemCommandResult }>> {
		await this.#withInvoices(session, work);
		const invoice = work.invoiceFor(input.entryId);
		const afterBuyerPaid = invoice?.status === "buyer_paid" || invoice?.status === "paid";
		const result = coreSellerRescind(
			item,
			itemContext(work.sale, work.saleStatus),
			actor,
			{
				entryId: input.entryId,
				reasonCode: input.reasonCode,
				explanation: input.explanation,
				passToNext: input.passToNext,
				afterBuyerPaid,
				confirmed: input.confirmed,
			},
			now,
		);
		if (!result.ok) return result;
		const rescind = createRescind(input.reasonCode, afterBuyerPaid, now);
		const entry = item.entries.find((e) => e.id === input.entryId)!;
		const applied = await this.#applyItem(
			session,
			work,
			item.id,
			result.value,
			new Map([[input.entryId, rescind.refundOwed]]),
		);
		if (!applied.ok) return applied;
		work.extra.push(
			this.db
				.prepare(
					`INSERT INTO rescinds (id, entry_id, seller_id, buyer_id, reason_code, explanation, attachment_key, fault, refund_owed, created_at)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
				)
				.bind(
					newId(),
					input.entryId,
					work.sale.sellerId,
					entry.buyerId,
					input.reasonCode,
					input.explanation.trim(),
					input.attachmentKey ?? null,
					rescind.fault,
					rescind.refundOwed ? 1 : 0,
					now,
				),
		);
		work.audit({
			action: input.passToNext ? "rescinded_and_passed" : "rescinded",
			actorId: auditActor,
			itemId: item.id,
			input: { entryId: input.entryId, reasonCode: input.reasonCode, refundOwed: rescind.refundOwed },
			events: result.value.events,
		});
		return ok({ work, value: this.#itemResult(work, item.id, input.entryId, result.value.events) });
	}

	/** A Pro buyer rescinds their own win before the invoice is sent (§4.3, D24). */
	buyerRescind(input: { itemId: string; entryId: string; buyerId: string }): Promise<Outcome<ItemCommandResult>> {
		return this.#transact([itemKey(input.itemId)], async (session, now) => {
			const loaded = await this.#loadItem(input.itemId, now);
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item } = loaded;
			const tier = await loadTier(this.db, input.buyerId, "buyer", now);
			const actor = actorFor(sale, input.buyerId, tier);
			if (actor.kind !== "buyer") return notAllowed();
			if (!permitted(actor, "rescind_own_win"))
				return reject("pro_only", "Rescinding a win is a Pro feature; request a take-back instead");
			await this.#withInvoices(session, work);
			const invoice = work.invoiceFor(input.entryId);
			const result = coreBuyerRescind(
				item,
				itemContext(sale, sale.sale.status),
				actor,
				{
					entryId: input.entryId,
					invoiceSent: invoice !== undefined && invoice.status !== "draft",
					rescindsThisMonth: await this.#proRescindsThisMonth(input.buyerId, now),
				},
				now,
			);
			if (!result.ok) return result;
			const applied = await this.#applyItem(session, work, input.itemId, result.value);
			if (!applied.ok) return applied;
			work.audit({
				action: "buyer_rescinded",
				actorId: input.buyerId,
				itemId: input.itemId,
				input: { entryId: input.entryId },
				events: result.value.events,
			});
			return ok({ work, value: this.#itemResult(work, input.itemId, input.entryId, result.value.events) });
		});
	}

	async #proRescindsThisMonth(buyerId: string, now: Millis): Promise<number> {
		const date = new Date(now);
		const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
		const row = await this.db
			.prepare(
				"SELECT count(*) AS n FROM entries WHERE user_id = ?1 AND ended_reason = 'buyer_rescind' AND ended_at >= ?2",
			)
			.bind(buyerId, monthStart)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	/** The buyer asks to give a win back (§5). */
	requestTakeback(input: {
		itemId: string;
		entryId: string;
		buyerId: string;
		reason?: string | null;
	}): Promise<Outcome<{ requestId: string }>> {
		return this.#transact([itemKey(input.itemId)], async (session, now) => {
			const loaded = await this.#loadItem(input.itemId, now);
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item } = loaded;
			const actor = actorFor(sale, input.buyerId);
			if (!permitted(actor, "request_takeback")) return notAllowed();
			const entry = item.entries.find((e) => e.id === input.entryId);
			if (!entry) return notFound("entry");
			await this.#withInvoices(session, work);
			const { results } = await this.db
				.prepare("SELECT * FROM takeback_requests WHERE entry_id = ?1")
				.bind(input.entryId)
				.all<TakebackRow>();
			const requestId = newId();
			const result = coreRequestTakeback(
				actor,
				{
					requestId,
					entryId: entry.id,
					entryBuyerId: entry.buyerId,
					entryWon: entry.status === "won",
					invoiceStatus: work.invoiceFor(entry.id)?.status ?? "none",
					previous: results.map(toTakeback),
				},
				now,
			);
			if (!result.ok) return result;
			const reason = input.reason?.trim() || null;
			work.extra.push(
				this.db
					.prepare(
						"INSERT INTO takeback_requests (id, entry_id, buyer_id, reason, status, created_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
					)
					.bind(requestId, entry.id, input.buyerId, reason, now),
			);
			const event = { type: "takeback_requested", requestId, entryId: entry.id };
			work.event({ ...event, itemId: item.id });
			work.audit({ action: "takeback_requested", actorId: input.buyerId, itemId: item.id, input: { requestId, entryId: entry.id }, events: [event] });
			return ok({ work, value: { requestId } });
		});
	}

	async #takebackRow(requestId: string) {
		return this.db
			.prepare(
				"SELECT t.*, e.item_id FROM takeback_requests t JOIN entries e ON e.id = t.entry_id JOIN items i ON i.id = e.item_id WHERE t.id = ?1 AND i.sale_id = ?2",
			)
			.bind(requestId, this.saleId)
			.first<TakebackRow & { item_id: string }>();
	}

	/** The seller approves (release + promote) or denies a take-back (§5). */
	async decideTakeback(input: {
		requestId: string;
		sellerId: string;
		approve: boolean;
	}): Promise<Outcome<ItemCommandResult>> {
		const located = await this.#takebackRow(input.requestId);
		if (!located) return notFound("take-back request");
		return this.#transact([itemKey(located.item_id)], async (session, now) => {
			const row = await this.#takebackRow(input.requestId);
			if (!row) return notFound("take-back request");
			const loaded = await this.#loadItem(row.item_id, now);
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item } = loaded;
			const actor = actorFor(sale, input.sellerId);
			const decided = coreDecideTakeback(toTakeback(row), actor, sale.sellerId, input.approve, now);
			if (!decided.ok) return decided;
			let events: readonly ItemEvent[] = [];
			if (input.approve) {
				const released = releaseForTakeback(item, itemContext(sale, sale.sale.status), actor, row.entry_id, now);
				if (!released.ok) return released;
				const applied = await this.#applyItem(session, work, item.id, released.value);
				if (!applied.ok) return applied;
				events = released.value.events;
			}
			work.extra.push(
				this.db
					.prepare("UPDATE takeback_requests SET status = ?1, decided_at = ?2 WHERE id = ?3 AND status = 'pending'")
					.bind(decided.value.status, now, row.id),
			);
			const event = { type: `takeback_${decided.value.status}`, requestId: row.id, entryId: row.entry_id };
			work.event({ ...event, itemId: item.id });
			work.audit({
				action: input.approve ? "takeback_approved" : "takeback_denied",
				actorId: input.sellerId,
				itemId: item.id,
				input: { requestId: row.id, entryId: row.entry_id },
				events: [event, ...events],
			});
			return ok({ work, value: this.#itemResult(work, item.id, row.entry_id, events) });
		});
	}

	/** The buyer withdraws their take-back request (§5). */
	async cancelTakeback(input: { requestId: string; buyerId: string }): Promise<Outcome<{ requestId: string }>> {
		const located = await this.#takebackRow(input.requestId);
		if (!located) return notFound("take-back request");
		return this.#transact([itemKey(located.item_id)], async (_session, now) => {
			const row = await this.#takebackRow(input.requestId);
			if (!row) return notFound("take-back request");
			const sale = await loadSale(this.db, this.saleId, now);
			if (!sale) return notFound();
			const cancelled = coreCancelTakeback(toTakeback(row), actorFor(sale, input.buyerId), now);
			if (!cancelled.ok) return cancelled;
			const work = new Work(this.db, sale, now);
			work.extra.push(
				this.db
					.prepare("UPDATE takeback_requests SET status = 'cancelled', decided_at = ?1 WHERE id = ?2 AND status = 'pending'")
					.bind(now, row.id),
			);
			const event = { type: "takeback_cancelled", requestId: row.id, entryId: row.entry_id };
			work.event({ ...event, itemId: row.item_id });
			work.audit({ action: "takeback_cancelled", actorId: input.buyerId, itemId: row.item_id, events: [event] });
			return ok({ work, value: { requestId: row.id } });
		});
	}

	// -------------------------------------------------------------------------
	// Sale lifecycle (§2)

	async #activeSaleCount(sellerId: string): Promise<number> {
		const row = await this.db
			.prepare("SELECT count(*) AS n FROM sales WHERE seller_id = ?1 AND id != ?2 AND status IN ('scheduled', 'live')")
			.bind(sellerId, this.saleId)
			.first<{ n: number }>();
		return row?.n ?? 0;
	}

	/**
	 * Publishes a draft now or for later.
	 *
	 * @spec SM-2-publish-scheduled
	 * @spec SM-2-publish-now
	 * @spec SM-2-free-sale-cap — counted before the transition and re-checked inside the write.
	 */
	publish(input: PublishInput): Promise<Outcome<SaleView>> {
		return this.#transact(["sale"], async (_session, now) => {
			const sale = await loadSale(this.db, this.saleId, now);
			if (!sale || sale.sellerId !== input.sellerId) return notFound();
			const result = publishSale(
				sale.sale,
				{ liveAt: input.liveAt, closesAt: input.closesAt, activeSaleCount: await this.#activeSaleCount(sale.sellerId) },
				now,
			);
			if (!result.ok) return result;
			const work = new Work(this.db, sale, now);
			const next = result.value.sale;
			work.saleChange = {
				expected: "draft",
				next,
				publishedAt: now,
				...(sale.sellerTier === "free" ? { activeSaleCap: FREE_ACTIVE_SALE_CAP } : {}),
			};
			for (const event of result.value.events) work.event({ ...event });
			work.audit({ action: "sale_published", actorId: input.sellerId, itemId: null, events: result.value.events });
			return ok({ work, value: { status: next.status, liveAt: next.liveAt, closesAt: next.closesAt } });
		});
	}

	unpublish(input: { sellerId: string }): Promise<Outcome<SaleView>> {
		return this.#transact(["sale"], async (_session, now) => {
			const sale = await loadSale(this.db, this.saleId, now);
			if (!sale || sale.sellerId !== input.sellerId) return notFound();
			const result = unpublishSale(sale.sale);
			if (!result.ok) return result;
			const work = new Work(this.db, sale, now);
			const next = result.value.sale;
			work.saleChange = { expected: "scheduled", next };
			for (const event of result.value.events) work.event({ ...event });
			work.audit({ action: "sale_unpublished", actorId: input.sellerId, itemId: null, events: result.value.events });
			return ok({ work, value: { status: next.status, liveAt: next.liveAt, closesAt: next.closesAt } });
		});
	}

	/**
	 * The alarm at `live_at`.
	 *
	 * @spec SM-2-go-live-alarm
	 */
	goLive(): Promise<Outcome<SaleView>> {
		return this.#transact(["sale"], async (_session, now) => {
			const sale = await loadSale(this.db, this.saleId, now);
			if (!sale) return notFound();
			const result = goLiveSale(sale.sale, now);
			if (!result.ok) return result;
			const work = new Work(this.db, sale, now);
			const next = result.value.sale;
			work.saleChange = { expected: "scheduled", next };
			for (const event of result.value.events) work.event({ ...event });
			work.audit({ action: "sale_live", actorId: "system", itemId: null, events: result.value.events });
			return ok({ work, value: { status: next.status, liveAt: next.liveAt, closesAt: next.closesAt } });
		});
	}

	/**
	 * The seller closes the sale, or the alarm at `closes_at` fires (§4.5).
	 *
	 * @spec SM-2-close — new entries are rejected (the status check in place()); item timers start or keep running.
	 * @spec SM-6-send-after-close — with auto-send on, every draft invoice goes out now.
	 */
	async close(input: { by: "seller"; sellerId: string } | { by: "alarm" }): Promise<Outcome<SaleView>> {
		const { results } = await this.db
			.prepare("SELECT id FROM items WHERE sale_id = ?1")
			.bind(this.saleId)
			.all<{ id: string }>();
		const itemIds = results.map((r) => r.id);
		return this.#transact(["sale", ...itemIds.map(itemKey)], async (session, now) => {
			const loaded = await loadSaleAndItems(this.db, this.saleId, "all", now);
			const sale = loaded.sale;
			if (!sale) return notFound();
			if (input.by === "seller" && input.sellerId !== sale.sellerId) return notFound();
			if (loaded.items.size !== itemIds.length || itemIds.some((id) => !loaded.items.has(id))) {
				throw new WriteConflict("The sale's items changed");
			}
			const result = closeSale(sale.sale, now, input.by);
			if (!result.ok) return result;
			const work = new Work(this.db, sale, now);
			work.addItems(loaded.items);
			const next = result.value.sale;
			work.saleChange = { expected: "live", next };
			const context = itemContext(sale, "closed");
			const events: unknown[] = [...result.value.events];
			for (const [itemId, slot] of work.items) {
				const closed = closeItem(slot.after, context, now);
				work.setItem(closed.item);
				for (const event of closed.events) {
					work.event({ ...event, itemId });
					events.push({ ...event, itemId });
				}
			}
			for (const event of result.value.events) work.event({ ...event });
			if (sale.settings.autoSendAtClose) {
				await this.#withInvoices(session, work);
				const sent = this.#sendDrafts(work, SYSTEM, "closed", now);
				if (!sent.ok) return sent;
				events.push(...sent.value);
			}
			const actorId = input.by === "seller" ? input.sellerId : "system";
			work.audit({ action: "sale_closed", actorId, itemId: null, events });
			return ok({ work, value: { status: next.status, liveAt: next.liveAt, closesAt: next.closesAt } });
		});
	}

	/** The seller closes the sale now. */
	closeBySeller(input: { sellerId: string }): Promise<Outcome<SaleView>> {
		return this.close({ by: "seller", sellerId: input.sellerId });
	}

	// -------------------------------------------------------------------------
	// Timers (§7)

	/**
	 * Runs one due timer. A timer that is no longer due (someone acted first, or the
	 * alarm is early) is a no-op.
	 */
	async runTimer(timer: Timer): Promise<Outcome<unknown>> {
		switch (timer.kind) {
			case "sale_live":
				return this.goLive();
			case "sale_close":
				return this.close({ by: "alarm" });
			case "decision_deadline":
				return this.#systemItemCommand(timer.itemId, "decision_window_expired", (item, _context, now) =>
					expireDecisionWindow(item, now),
				);
			case "offers_lapse":
				return this.#systemItemCommand(timer.itemId, "offers_lapsed", (item, _context, now) =>
					lapseOffersAfterClose(item, now),
				);
			case "counter_expiry":
				return this.#systemItemCommand(timer.itemId, "counter_expired", (item, _context, now) =>
					expireCounter(item, timer.entryId, now),
				);
			case "invoice_due":
				return this.markOverdue(timer.invoiceId);
			case "invoice_autocomplete":
				return this.completeInvoice({ invoiceId: timer.invoiceId, actor: "system" });
		}
	}

	#systemItemCommand(
		itemId: string,
		action: string,
		transition: (item: Item, context: ItemContext, now: Millis) => ItemResult,
	): Promise<Outcome<ItemCommandResult>> {
		return this.#transact([itemKey(itemId)], async (session, now) => {
			const loaded = await this.#loadItem(itemId, now);
			if ("missing" in loaded) return loaded.missing!;
			const { sale, work, item } = loaded;
			const result = transition(item, itemContext(sale, sale.sale.status), now);
			if (!result.ok) return result;
			const applied = await this.#applyItem(session, work, itemId, result.value);
			if (!applied.ok) return applied;
			work.audit({ action, actorId: "system", itemId, events: result.value.events });
			return ok({ work, value: this.#itemResult(work, itemId, null, result.value.events) });
		});
	}

	// -------------------------------------------------------------------------
	// Invoices (§6)

	/** The items holding an invoice's lines (read before locking; re-checked inside). */
	async #invoiceItemIds(invoiceId: string): Promise<string[]> {
		const { results } = await this.db
			.prepare(
				"SELECT DISTINCT e.item_id AS id FROM invoice_lines l JOIN entries e ON e.id = l.entry_id JOIN invoices i ON i.id = l.invoice_id WHERE l.invoice_id = ?1 AND i.sale_id = ?2",
			)
			.bind(invoiceId, this.saleId)
			.all<{ id: string }>();
		return results.map((r) => r.id).toSorted();
	}

	/**
	 * An invoice command. With `withItems`, it also locks and loads the items holding
	 * the invoice's lines (completion fulfils entries; payment can end backups).
	 */
	async #invoiceCommand<A>(
		invoiceId: string,
		withItems: boolean,
		body: (session: LockSession, work: Work, invoice: Invoice, now: Millis) => Promise<Outcome<A>>,
	): Promise<Outcome<A>> {
		const itemIds = withItems ? await this.#invoiceItemIds(invoiceId) : [];
		return this.#transact([...itemIds.map(itemKey), "invoices"], async (session, now) => {
			const loaded = withItems
				? await loadSaleAndItems(this.db, this.saleId, itemIds, now)
				: { sale: await loadSale(this.db, this.saleId, now), items: new Map() };
			if (!loaded.sale) return notFound();
			const work = new Work(this.db, loaded.sale, now);
			work.addItems(loaded.items);
			await this.#withInvoices(session, work);
			const invoice = work.invoice(invoiceId);
			if (!invoice) return notFound("invoice");
			if (withItems && (await this.#invoiceItemIds(invoiceId)).join() !== itemIds.join()) {
				throw new WriteConflict("The invoice's lines changed");
			}
			const result = await body(session, work, invoice, now);
			if (!result.ok) return result;
			return ok({ work, value: result.value });
		});
	}

	#applyInvoice(work: Work, result: Result<InvoiceTransition, InvoiceRejection>): Outcome<Invoice> {
		if (!result.ok) return result;
		work.setInvoice(result.value.invoice);
		for (const event of result.value.events) work.event({ ...event, invoiceId: result.value.invoice.id });
		return ok(result.value.invoice);
	}

	#view(invoice: Invoice): InvoiceView {
		return { ...invoice, saleId: this.saleId };
	}

	#sendDrafts(work: Work, actor: Actor, saleStatus: SaleStatus, now: Millis): Outcome<unknown[]> {
		const events: unknown[] = [];
		for (const invoice of work.allInvoices()) {
			if (invoice.status !== "draft" || invoice.lines.length === 0) continue;
			const sent = this.#applyInvoice(work, sendInvoice(invoice, actor, saleStatus, work.sale.settings.paymentDeadline, now));
			if (!sent.ok) return sent;
			events.push({ type: "invoice_sent", invoiceId: invoice.id, dueAt: sent.value.dueAt });
		}
		return ok(events);
	}

	/**
	 * The seller sends one draft invoice.
	 *
	 * @spec SM-6-send-after-close
	 * @spec SM-6-payment-deadline
	 */
	sendInvoice(input: { invoiceId: string; sellerId: string }): Promise<Outcome<InvoiceView>> {
		return this.#invoiceCommand(input.invoiceId, false, async (_session, work, invoice, now) => {
			const sent = this.#applyInvoice(
				work,
				sendInvoice(invoice, actorFor(work.sale, input.sellerId), work.saleStatus, work.sale.settings.paymentDeadline, now),
			);
			if (!sent.ok) return sent;
			work.audit({ action: "invoice_sent", actorId: input.sellerId, itemId: null, input: { invoiceId: invoice.id }, events: [] });
			return ok(this.#view(sent.value));
		});
	}

	/** "Send all": every draft with lines (D49). */
	async sendAllInvoices(input: { sellerId: string }): Promise<Outcome<{ sent: number }>> {
		return this.#transact(["invoices"], async (session, now) => {
			const sale = await loadSale(this.db, this.saleId, now);
			if (!sale || sale.sellerId !== input.sellerId) return notFound();
			const work = new Work(this.db, sale, now);
			await this.#withInvoices(session, work);
			const sent = this.#sendDrafts(work, sellerActor(sale), sale.sale.status, now);
			if (!sent.ok) return sent;
			if (sent.value.length > 0) work.audit({ action: "invoices_sent", actorId: input.sellerId, itemId: null, events: sent.value });
			return ok({ work, value: { sent: sent.value.length } });
		});
	}

	/** @spec SM-6-shipping-threshold — the buyer picks one of the options their subtotal allows. */
	markBuyerPaid(input: {
		invoiceId: string;
		buyerId: string;
		shippingOptionId: string;
		paymentRef: string | null;
	}): Promise<Outcome<InvoiceView>> {
		return this.#invoiceCommand(input.invoiceId, false, async (_session, work, invoice, now) => {
			const paid = this.#applyInvoice(
				work,
				coreMarkBuyerPaid(
					invoice,
					actorFor(work.sale, input.buyerId),
					work.sale.settings.shippingMenu,
					input.shippingOptionId,
					input.paymentRef?.trim() || null,
					now,
				),
			);
			if (!paid.ok) return paid;
			work.audit({ action: "invoice_buyer_paid", actorId: input.buyerId, itemId: null, input: { invoiceId: invoice.id }, events: [] });
			return ok(this.#view(paid.value));
		});
	}

	/**
	 * The seller confirms the payment; items whose every unit is now paid end their backups.
	 *
	 * @spec SM-6-gmv
	 * @spec SM-4.5-backups-lost
	 */
	confirmPaid(input: { invoiceId: string; sellerId: string }): Promise<Outcome<InvoiceView>> {
		return this.#invoiceCommand(input.invoiceId, true, async (_session, work, invoice, now) => {
			const paid = this.#applyInvoice(work, coreConfirmPaid(invoice, actorFor(work.sale, input.sellerId)));
			if (!paid.ok) return paid;
			const paidEntries = new Set(
				work
					.allInvoices()
					.filter((inv) => inv.status === "paid" || inv.status === "shipped" || inv.status === "completed")
					.flatMap((inv) => inv.lines.filter((l) => !l.refundOwed).map((l) => l.entryId)),
			);
			const events: unknown[] = [];
			for (const [itemId, slot] of work.items) {
				const paidUnits = slot.after.entries.filter(
					(e) => (e.status === "won" || e.status === "fulfilled") && paidEntries.has(e.id),
				).length;
				const lost = loseBackups(slot.after, work.saleStatus, paidUnits, now);
				work.setItem(lost.item);
				for (const event of lost.events) {
					work.event({ ...event, itemId });
					events.push({ ...event, itemId });
				}
			}
			work.audit({ action: "invoice_paid", actorId: input.sellerId, itemId: null, input: { invoiceId: invoice.id }, events });
			return ok(this.#view(paid.value));
		});
	}

	paymentNotReceived(input: { invoiceId: string; sellerId: string }): Promise<Outcome<InvoiceView>> {
		return this.#invoiceCommand(input.invoiceId, false, async (_session, work, invoice) => {
			const back = this.#applyInvoice(work, corePaymentNotReceived(invoice, actorFor(work.sale, input.sellerId)));
			if (!back.ok) return back;
			work.audit({ action: "invoice_not_received", actorId: input.sellerId, itemId: null, input: { invoiceId: invoice.id }, events: [] });
			return ok(this.#view(back.value));
		});
	}

	/** @spec SM-6-paid-flow — tracking is required above the threshold. */
	ship(input: {
		invoiceId: string;
		sellerId: string;
		tracking: { carrier: string; number: string } | null;
	}): Promise<Outcome<InvoiceView>> {
		return this.#invoiceCommand(input.invoiceId, false, async (_session, work, invoice, now) => {
			const shipped = this.#applyInvoice(work, shipInvoice(invoice, actorFor(work.sale, input.sellerId), input.tracking, now));
			if (!shipped.ok) return shipped;
			work.audit({ action: "invoice_shipped", actorId: input.sellerId, itemId: null, input: { invoiceId: invoice.id }, events: [] });
			return ok(this.#view(shipped.value));
		});
	}

	/**
	 * The buyer confirms receipt, or the autocomplete timer fires; the invoice's wins are fulfilled.
	 *
	 * @spec SM-6-autocomplete
	 */
	completeInvoice(input: { invoiceId: string; actor: "system" } | { invoiceId: string; buyerId: string }): Promise<Outcome<InvoiceView>> {
		return this.#invoiceCommand(input.invoiceId, true, async (_session, work, invoice, now) => {
			const actor = "buyerId" in input ? actorFor(work.sale, input.buyerId) : SYSTEM;
			const done = this.#applyInvoice(work, completeInvoice(invoice, actor, now));
			if (!done.ok) return done;
			const entryIds = new Set(done.value.lines.filter((l) => !l.refundOwed).map((l) => l.entryId));
			const events: unknown[] = [];
			for (const [itemId, slot] of work.items) {
				const fulfilled = fulfill(slot.after, entryIds, now);
				work.setItem(fulfilled.item);
				for (const event of fulfilled.events) {
					work.event({ ...event, itemId });
					events.push({ ...event, itemId });
				}
			}
			const actorId = "buyerId" in input ? input.buyerId : "system";
			work.audit({ action: "invoice_completed", actorId, itemId: null, input: { invoiceId: invoice.id }, events });
			return ok(this.#view(done.value));
		});
	}

	/** One batch of an item import (WS-G); see import.ts. Holds the sale lock, so batches apply one at a time. */
	applyImportBatch(input: ImportBatchInput): Promise<Outcome<ImportBatchResult>> {
		return this.#transact(["sale"], async (_session, now) => {
			const sale = await loadSale(this.db, this.saleId, now);
			if (!sale) return notFound();
			return planImportBatch(this.db, sale, input, now);
		});
	}

	/**
	 * The payment deadline passed: the invoice is overdue and, with auto-rescind on
	 * (D13), every line is rescinded for non-payment and passed to the next backup.
	 *
	 * @spec SM-6-payment-deadline
	 */
	markOverdue(invoiceId: string): Promise<Outcome<InvoiceView>> {
		return this.#invoiceCommand(invoiceId, true, async (session, work, invoice, now) => {
			const overdue = this.#applyInvoice(work, markOverdue(invoice, work.sale.settings.autoRescindOverdue, now));
			if (!overdue.ok) return overdue;
			const request = work.sale.settings.autoRescindOverdue ? overdue.value.lines : [];
			work.audit({ action: "invoice_overdue", actorId: "system", itemId: null, input: { invoiceId: invoice.id }, events: [] });
			for (const line of request) {
				const itemId = [...work.items].find(([, slot]) => slot.after.entries.some((e) => e.id === line.entryId))?.[0];
				const item = itemId === undefined ? undefined : work.item(itemId);
				if (!item) continue;
				const rescinded = await this.#rescind(
					session,
					work,
					item,
					sellerActor(work.sale),
					{
						itemId: item.id,
						entryId: line.entryId,
						reasonCode: "buyer_nonpayment",
						explanation: "Automatic rescind: the payment deadline passed.",
						passToNext: true,
						confirmed: true,
					},
					"system",
					now,
				);
				if (!rescinded.ok) return rescinded;
			}
			return ok(this.#view(work.invoice(invoiceId)!));
		});
	}
}
