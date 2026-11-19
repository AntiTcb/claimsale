import {
	invoiceNumberLabel,
	reject,
	shippingMenuFrom,
	shippingOptionsFor,
	trackingRequiredFor,
	type Invoice,
	type InvoiceStatus,
	type ItemKind,
	type Millis,
	type Rejection,
	type Result,
	type ShippingAddress,
	type ShippingOption,
	type Tier,
	type Tracking,
} from "@claimsale/core";
import { and, asc, desc, eq, inList, ne, type Db } from "@claimsale/db";
import { entries, invoiceLines, invoices, items, sales, sellerProfiles, users } from "@claimsale/db/schema";
import type { Outcome, RpcResult, TrackingRowResult } from "@claimsale/engine";
import { readTerms } from "#lib/listing-input.ts";
import type { ImportableInvoice } from "#lib/tracking-import.ts";
import { entitlements } from "./entitlements.ts";

/**
 * Invoices after close (STATE_MACHINES §6, WS-J): what the seller's buyers page and
 * invoice page, and the buyer's invoice page, read from D1. Every change goes through
 * the sale engine's RPC methods ({@link invoiceCommands}); this module only reads.
 *
 * The buyer's shipping address is personal data: it is read only for the invoice's
 * own seller and buyer, and never logged.
 */

export interface InvoiceLineView {
	readonly entryId: string;
	readonly title: string;
	readonly amountCents: number;
	readonly refundOwed: boolean;
	readonly kind: ItemKind;
}

export interface InvoiceDetail {
	readonly id: string;
	readonly saleId: string;
	readonly sellerId: string;
	readonly number: string;
	readonly status: InvoiceStatus;
	readonly buyer: { readonly id: string; readonly handle: string | null; readonly displayName: string };
	readonly lines: readonly InvoiceLineView[];
	readonly subtotalCents: number;
	readonly shippingCents: number;
	readonly adjustmentCents: number;
	readonly totalCents: number;
	readonly shippingOptionId: string | null;
	readonly shippingOptionLabel: string | null;
	readonly paymentRef: string | null;
	readonly address: ShippingAddress | null;
	readonly tracking: Tracking | null;
	readonly sentAt: Millis | null;
	readonly dueAt: Millis | null;
	readonly buyerPaidAt: Millis | null;
	readonly paidAt: Millis | null;
	readonly shippedAt: Millis | null;
	readonly completedAt: Millis | null;
	/** Whether shipping needs a tracking number (D15, TCG-tracked-graded-sealed). */
	readonly trackingRequired: boolean;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The address snapshot stored on the invoice at payment (SM-6-address-snapshot). */
export function addressFrom(value: unknown): ShippingAddress | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const a: Record<string, unknown> = Object.fromEntries(Object.entries(value));
	return {
		name: text(a["name"]),
		line1: text(a["line1"]),
		line2: typeof a["line2"] === "string" ? a["line2"] : null,
		city: text(a["city"]),
		region: text(a["region"]),
		postalCode: text(a["postalCode"]),
		country: text(a["country"]),
	};
}

type InvoiceRow = typeof invoices.$inferSelect;

async function linesOf(db: Db, invoiceIds: readonly string[]) {
	if (invoiceIds.length === 0) return [];
	return db
		.select({
			invoiceId: invoiceLines.invoiceId,
			entryId: invoiceLines.entryId,
			title: invoiceLines.description,
			amountCents: invoiceLines.amountCents,
			refundOwed: invoiceLines.refundOwed,
			kind: items.kind,
		})
		.from(invoiceLines)
		.innerJoin(entries, eq(entries.id, invoiceLines.entryId))
		.innerJoin(items, eq(items.id, entries.itemId))
		.where(inList(invoiceLines.invoiceId, [...invoiceIds]))
		.orderBy(asc(invoiceLines.createdAt), asc(invoiceLines.id))
		.all();
}

/** Core's view of a stored invoice, for its threshold rules. */
function coreInvoice(row: InvoiceRow, lines: readonly InvoiceLineView[], sellerTier: Tier): Invoice {
	return {
		id: row.id,
		buyerId: row.buyerId,
		sellerId: row.sellerId,
		sellerTier,
		status: row.status,
		lines: lines.map((l) => ({
			entryId: l.entryId,
			description: l.title,
			amountCents: l.amountCents,
			refundOwed: l.refundOwed,
		})),
		shippingCents: row.shippingCents,
		adjustmentCents: row.adjustmentCents,
		shippingOptionId: row.shippingOptionId,
		paymentRef: row.paymentRef,
		tracking: row.carrier && row.trackingNumber ? { carrier: row.carrier, number: row.trackingNumber } : null,
		sentAt: row.sentAt,
		dueAt: row.dueAt,
		paidAt: row.buyerPaidAt,
		shippedAt: row.shippedAt,
		completedAt: row.completedAt,
		gmvCents: row.gmvCents,
	};
}

async function detail(db: Db, row: InvoiceRow, now: Millis): Promise<InvoiceDetail> {
	const [lines, buyer, tiers] = await Promise.all([
		linesOf(db, [row.id]),
		db
			.select({ id: users.id, handle: users.handle, displayName: users.displayName })
			.from(users)
			.where(eq(users.id, row.buyerId))
			.get(),
		entitlements(db, row.sellerId, now),
	]);
	const lineViews = lines.map((l): InvoiceLineView => ({
		entryId: l.entryId,
		title: l.title,
		amountCents: l.amountCents,
		refundOwed: l.refundOwed,
		kind: l.kind,
	}));
	// The same kinds the engine checks: every line's item (TCG-tracked-graded-sealed).
	const kinds = [...new Set(lineViews.map((l) => l.kind))];
	return {
		id: row.id,
		saleId: row.saleId,
		sellerId: row.sellerId,
		number: invoiceNumberLabel(row.invoiceNumber, row.id),
		status: row.status,
		buyer: buyer ?? { id: row.buyerId, handle: null, displayName: "" },
		lines: lineViews,
		subtotalCents: row.subtotalCents,
		shippingCents: row.shippingCents,
		adjustmentCents: row.adjustmentCents,
		totalCents: row.totalCents,
		shippingOptionId: row.shippingOptionId,
		shippingOptionLabel: row.shippingOptionLabel,
		paymentRef: row.paymentRef,
		address: addressFrom(row.shippingAddress),
		tracking: row.carrier && row.trackingNumber ? { carrier: row.carrier, number: row.trackingNumber } : null,
		sentAt: row.sentAt,
		dueAt: row.dueAt,
		buyerPaidAt: row.buyerPaidAt,
		paidAt: row.paidAt,
		shippedAt: row.shippedAt,
		completedAt: row.completedAt,
		trackingRequired: trackingRequiredFor(coreInvoice(row, lineViews, tiers.seller), kinds),
	};
}

/** One of the seller's invoices in one of their sales, or undefined (the same for anyone else's). */
export async function sellerInvoice(
	db: Db,
	sellerId: string,
	saleId: string,
	invoiceId: string,
	now: Millis,
): Promise<InvoiceDetail | undefined> {
	const row = await db
		.select()
		.from(invoices)
		.where(and(eq(invoices.id, invoiceId), eq(invoices.saleId, saleId), eq(invoices.sellerId, sellerId)))
		.get();
	return row ? detail(db, row, now) : undefined;
}

export interface PaymentHandle {
	readonly kind: string;
	readonly value: string;
}

export interface BuyerInvoice extends InvoiceDetail {
	readonly sale: { readonly id: string; readonly title: string; readonly slug: string };
	readonly seller: {
		readonly handle: string | null;
		readonly displayName: string;
		readonly paymentHandles: readonly PaymentHandle[];
	};
	/** Payment method IDs from the sale's terms (PAYMENT_METHODS). */
	readonly paymentMethods: readonly string[];
	/** The options this buyer may pick (SM-6-shipping-threshold, TCG-tracked-graded-sealed). */
	readonly shippingOptions: readonly ShippingOption[];
}

export function paymentHandlesFrom(value: unknown): PaymentHandle[] {
	if (!Array.isArray(value)) return [];
	const out: PaymentHandle[] = [];
	const list: readonly unknown[] = value;
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const fields: Record<string, unknown> = Object.fromEntries(Object.entries(entry));
		const kind = fields["kind"];
		const handle = fields["value"];
		if (typeof kind === "string" && typeof handle === "string" && handle.trim() !== "")
			out.push({ kind, value: handle });
	}
	return out;
}

/** The buyer's own invoice with what they need to pay it, or undefined (also for anyone else's). */
export async function buyerInvoice(
	db: Db,
	buyerId: string,
	invoiceId: string,
	now: Millis,
): Promise<BuyerInvoice | undefined> {
	const row = await db
		.select()
		.from(invoices)
		.where(and(eq(invoices.id, invoiceId), eq(invoices.buyerId, buyerId)))
		.get();
	if (!row) return undefined;
	const [base, sale, seller, tiers] = await Promise.all([
		detail(db, row, now),
		db
			.select({
				id: sales.id,
				title: sales.title,
				slug: sales.slug,
				terms: sales.terms,
				shipping: sales.shipping,
			})
			.from(sales)
			.where(eq(sales.id, row.saleId))
			.get(),
		db
			.select({
				handle: users.handle,
				displayName: users.displayName,
				paymentHandles: sellerProfiles.paymentHandles,
			})
			.from(users)
			.leftJoin(sellerProfiles, eq(sellerProfiles.userId, users.id))
			.where(eq(users.id, row.sellerId))
			.get(),
		entitlements(db, row.sellerId, now),
	]);
	if (!sale) return undefined;
	const kinds = [...new Set(base.lines.map((l) => l.kind))];
	return {
		...base,
		sale: { id: sale.id, title: sale.title, slug: sale.slug },
		seller: {
			handle: seller?.handle ?? null,
			displayName: seller?.displayName ?? "",
			paymentHandles: paymentHandlesFrom(seller?.paymentHandles),
		},
		paymentMethods: readTerms(sale.terms).paymentMethods,
		shippingOptions: shippingOptionsFor(
			shippingMenuFrom(sale.shipping),
			base.subtotalCents,
			tiers.seller,
			kinds,
		),
	};
}

export interface InvoiceSummary {
	readonly id: string;
	readonly number: string;
	readonly status: InvoiceStatus;
	readonly totalCents: number;
	readonly dueAt: Millis | null;
	readonly lineCount: number;
}

export interface SaleBuyer {
	readonly buyer: { readonly id: string; readonly handle: string | null; readonly displayName: string };
	readonly invoices: readonly InvoiceSummary[];
}

/** The per-buyer rollup for /sell/[saleId]/buyers: every buyer with an invoice in the sale. */
export async function saleBuyers(db: Db, saleId: string): Promise<SaleBuyer[]> {
	const rows = await db
		.select({
			invoice: invoices,
			handle: users.handle,
			displayName: users.displayName,
		})
		.from(invoices)
		.innerJoin(users, eq(users.id, invoices.buyerId))
		.where(eq(invoices.saleId, saleId))
		.orderBy(asc(users.handle), asc(invoices.createdAt))
		.all();
	const lines = await linesOf(
		db,
		rows.map((r) => r.invoice.id),
	);
	const byBuyer = new Map<string, { buyer: SaleBuyer["buyer"]; invoices: InvoiceSummary[] }>();
	for (const { invoice, handle, displayName } of rows) {
		const entry = byBuyer.get(invoice.buyerId) ?? {
			buyer: { id: invoice.buyerId, handle, displayName },
			invoices: [],
		};
		entry.invoices.push({
			id: invoice.id,
			number: invoiceNumberLabel(invoice.invoiceNumber, invoice.id),
			status: invoice.status,
			totalCents: invoice.totalCents,
			dueAt: invoice.dueAt,
			lineCount: lines.filter((l) => l.invoiceId === invoice.id).length,
		});
		byBuyer.set(invoice.buyerId, entry);
	}
	return [...byBuyer.values()];
}

export interface BuyerInvoiceSummary extends InvoiceSummary {
	readonly saleTitle: string;
	readonly sellerHandle: string | null;
}

/** The buyer's invoices across sales, newest first (D53: drafts show the running total). */
export async function listBuyerInvoices(db: Db, buyerId: string): Promise<BuyerInvoiceSummary[]> {
	const rows = await db
		.select({ invoice: invoices, saleTitle: sales.title, sellerHandle: users.handle })
		.from(invoices)
		.innerJoin(sales, eq(sales.id, invoices.saleId))
		.innerJoin(users, eq(users.id, invoices.sellerId))
		.where(and(eq(invoices.buyerId, buyerId), ne(invoices.status, "cancelled")))
		.orderBy(desc(invoices.createdAt))
		.all();
	const lines = await linesOf(
		db,
		rows.map((r) => r.invoice.id),
	);
	return rows.map(({ invoice, saleTitle, sellerHandle }) => ({
		id: invoice.id,
		number: invoiceNumberLabel(invoice.invoiceNumber, invoice.id),
		status: invoice.status,
		totalCents: invoice.totalCents,
		dueAt: invoice.dueAt,
		lineCount: lines.filter((l) => l.invoiceId === invoice.id).length,
		saleTitle,
		sellerHandle,
	}));
}

/** The sale's sent invoices as the tracking import matches and previews them (IO-tracking-match). */
export async function importableInvoices(db: Db, saleId: string): Promise<ImportableInvoice[]> {
	const rows = await db
		.select({
			id: invoices.id,
			number: invoices.invoiceNumber,
			status: invoices.status,
			carrier: invoices.carrier,
			trackingNumber: invoices.trackingNumber,
			buyerHandle: users.handle,
		})
		.from(invoices)
		.innerJoin(users, eq(users.id, invoices.buyerId))
		.where(and(eq(invoices.saleId, saleId), ne(invoices.status, "cancelled"), ne(invoices.status, "draft")))
		.orderBy(asc(invoices.invoiceNumber))
		.all();
	return rows.map((r) => ({
		id: r.id,
		number: invoiceNumberLabel(r.number, r.id),
		status: r.status,
		tracking: r.carrier && r.trackingNumber ? { carrier: r.carrier, number: r.trackingNumber } : null,
		buyerHandle: r.buyerHandle,
	}));
}

// ---------------------------------------------------------------------------
// Commands (all through the engine)

/** The engine methods this module calls (the `ENGINE` service binding has them all). */
export type InvoiceBinding = Pick<
	Env["ENGINE"],
	| "sendInvoice"
	| "sendAllInvoices"
	| "markInvoicePaid"
	| "confirmInvoicePaid"
	| "invoiceNotReceived"
	| "shipInvoice"
	| "replaceInvoiceTracking"
	| "completeInvoice"
	| "rescindOverdueInvoice"
	| "applyTracking"
	| "closeSale"
>;

export type CommandResult<A = true> = Result<A, Rejection>;

const unavailable = () =>
	reject("engine_unavailable", "The sale engine didn't answer. Try again in a moment.");

async function settle<A>(call: Promise<RpcResult<Outcome<A>>>): Promise<CommandResult<A>> {
	const result = await call;
	if (!result.ok) return unavailable();
	return result.value;
}

const done = <A>(result: CommandResult<A>): CommandResult => (result.ok ? { ok: true, value: true } : result);

/**
 * The invoice commands over RPC. The web Worker passes the authenticated user; the
 * engine decides whether they are the seller or the buyer (§8) and runs core's rules.
 */
export function invoiceCommands(binding: InvoiceBinding) {
	return {
		send: async (saleId: string, invoiceId: string, sellerId: string) =>
			done(await settle(binding.sendInvoice({ saleId, invoiceId, sellerId }))),
		sendAll: async (saleId: string, sellerId: string) =>
			settle<{ sent: number }>(binding.sendAllInvoices({ saleId, sellerId })),
		closeSale: async (saleId: string, sellerId: string) =>
			done(await settle(binding.closeSale({ saleId, sellerId }))),
		markPaid: async (input: {
			saleId: string;
			invoiceId: string;
			buyerId: string;
			shippingOptionId: string;
			addressId: string;
			paymentRef: string | null;
		}) => done(await settle(binding.markInvoicePaid(input))),
		confirmPaid: async (saleId: string, invoiceId: string, sellerId: string) =>
			done(await settle(binding.confirmInvoicePaid({ saleId, invoiceId, sellerId }))),
		notReceived: async (saleId: string, invoiceId: string, sellerId: string) =>
			done(await settle(binding.invoiceNotReceived({ saleId, invoiceId, sellerId }))),
		ship: async (saleId: string, invoiceId: string, sellerId: string, tracking: Tracking | null) =>
			done(await settle(binding.shipInvoice({ saleId, invoiceId, sellerId, tracking }))),
		replaceTracking: async (saleId: string, invoiceId: string, sellerId: string, tracking: Tracking) =>
			done(await settle(binding.replaceInvoiceTracking({ saleId, invoiceId, sellerId, tracking }))),
		complete: async (saleId: string, invoiceId: string, buyerId: string) =>
			done(await settle(binding.completeInvoice({ saleId, invoiceId, buyerId }))),
		rescindOverdue: async (saleId: string, invoiceId: string, sellerId: string) =>
			done(await settle(binding.rescindOverdueInvoice({ saleId, invoiceId, sellerId }))),
		applyTracking: async (
			saleId: string,
			sellerId: string,
			rows: ReadonlyArray<{
				row: number;
				invoiceId: string;
				carrier: string;
				number: string;
				replace: boolean;
			}>,
		) => settle<{ rows: TrackingRowResult[] }>(binding.applyTracking({ saleId, sellerId, rows: [...rows] })),
	};
}

export type InvoiceCommands = ReturnType<typeof invoiceCommands>;
