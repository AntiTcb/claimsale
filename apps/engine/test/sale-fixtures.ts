import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { Entry, Millis } from "@claimsale/core";
import type { RpcResult } from "../src/runtime.ts";
import type { Outcome, SaleEngine } from "../src/sale-engine.ts";

/**
 * Test data for the sale write path. Every test makes its own users, sale and items
 * with fresh IDs, so tests don't depend on each other's rows.
 */

export const db = env.DB;
export const engine = exports.default;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

let counter = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export async function addUser(
	id = uid("u"),
	options: { emailVerified?: boolean; createdAt?: Millis; sellerPro?: boolean; buyerPro?: boolean } = {},
) {
	const createdAt = options.createdAt ?? Date.now() - 365 * DAY;
	await db
		.prepare(
			"INSERT INTO users (id, email, display_name, email_verified, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
		)
		.bind(id, `${id}@example.test`, id, options.emailVerified === false ? 0 : 1, createdAt)
		.run();
	for (const [flag, plan] of [
		[options.sellerPro, "seller_pro"],
		[options.buyerPro, "buyer_pro"],
	] as const) {
		if (flag) {
			await db
				.prepare(
					"INSERT INTO subscriptions (user_id, plan_id, status, created_at, updated_at) VALUES (?1, ?2, 'granted', 1, 1)",
				)
				.bind(id, plan)
				.run();
		}
	}
	return id;
}

export interface SaleSetup {
	readonly saleId: string;
	readonly sellerId: string;
	readonly itemIds: string[];
}

export interface ItemSetup {
	readonly priceCents?: number;
	readonly quantity?: number;
	readonly perBuyerLimit?: number;
	readonly offers?: "off" | "on" | "on_min";
	readonly minOfferCents?: number | null;
	readonly title?: string;
}

/** A sale with items. Default: live since an hour ago, closing in two days. */
export async function makeSale(
	options: {
		status?: "draft" | "scheduled" | "live" | "closed";
		liveAt?: Millis | null;
		closesAt?: Millis | null;
		terms?: Record<string, unknown>;
		shipping?: unknown;
		items?: ItemSetup[];
		sellerPro?: boolean;
		sellerId?: string;
	} = {},
): Promise<SaleSetup> {
	const now = Date.now();
	const sellerId = options.sellerId ?? (await addUser(uid("seller"), { sellerPro: options.sellerPro ?? false }));
	const saleId = uid("sale");
	const status = options.status ?? "live";
	await db
		.prepare(
			`INSERT INTO sales (id, seller_id, slug, title, status, live_at, closes_at, terms, shipping, created_at, updated_at)
			VALUES (?1, ?2, ?3, 'Test sale', ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
		)
		.bind(
			saleId,
			sellerId,
			saleId,
			status,
			options.liveAt === undefined ? (status === "draft" ? null : now - HOUR) : options.liveAt,
			options.closesAt === undefined ? (status === "draft" ? null : now + 2 * DAY) : options.closesAt,
			JSON.stringify(options.terms ?? {}),
			options.shipping === undefined ? null : JSON.stringify(options.shipping),
			now,
		)
		.run();
	const itemIds: string[] = [];
	for (const [i, item] of (options.items ?? [{}]).entries()) {
		const id = uid("item");
		itemIds.push(id);
		await db
			.prepare(
				`INSERT INTO items (id, sale_id, sort_order, game_id, title, price_cents, quantity, per_buyer_limit, offers_mode, min_offer_cents, created_at, updated_at)
				VALUES (?1, ?2, ?3, 'pokemon', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
			)
			.bind(
				id,
				saleId,
				i,
				item.title ?? `Card ${i}`,
				item.priceCents ?? 4000,
				item.quantity ?? 1,
				item.perBuyerLimit ?? 1,
				item.offers ?? "on",
				item.minOfferCents ?? null,
				now,
			)
			.run();
	}
	return { saleId, sellerId, itemIds };
}

export const stubFor = (saleId: string) => env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName(saleId));

/** Sets the sale's engine clock (server time) for the rest of the test. */
export async function setClock(saleId: string, at: Millis) {
	await runInDurableObject(stubFor(saleId), (instance: SaleEngine) => {
		instance.clock = () => at;
	});
}

/** Unwraps the RPC layer; the domain Outcome stays. */
export function outcome<A>(result: RpcResult<Outcome<A>>): Outcome<A> {
	if (!result.ok) throw new Error(`RPC failed: ${result.error.name}: ${result.error.message}`);
	return result.value;
}

/** Unwraps both layers, failing the test on a rejection. */
export function value<A>(result: RpcResult<Outcome<A>>): A {
	const o = outcome(result);
	if (!o.ok) throw new Error(`rejected: ${o.error.code}: ${o.error.message}`);
	return o.value;
}

export function rejection<A>(result: RpcResult<Outcome<A>>): string {
	const o = outcome(result);
	if (o.ok) throw new Error("expected a rejection, got ok");
	return o.error.code;
}

export async function entriesOf(itemId: string) {
	const { results } = await db
		.prepare("SELECT * FROM entries WHERE item_id = ?1 ORDER BY created_at, id")
		.bind(itemId)
		.all<Record<string, unknown>>();
	return results;
}

export async function itemRow(itemId: string) {
	return (await db.prepare("SELECT * FROM items WHERE id = ?1").bind(itemId).first<Record<string, unknown>>())!;
}

export async function saleRow(saleId: string) {
	return (await db.prepare("SELECT * FROM sales WHERE id = ?1").bind(saleId).first<Record<string, unknown>>())!;
}

export async function invoicesOf(saleId: string) {
	const { results } = await db
		.prepare("SELECT * FROM invoices WHERE sale_id = ?1 ORDER BY created_at, id")
		.bind(saleId)
		.all<Record<string, unknown>>();
	const out = [];
	for (const invoice of results) {
		const lines = await db
			.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ?1 ORDER BY created_at, id")
			.bind(invoice["id"])
			.all<Record<string, unknown>>();
		out.push({ ...invoice, lines: lines.results });
	}
	return out;
}

export async function auditOf(saleId: string) {
	const { results } = await db
		.prepare("SELECT * FROM audit_log WHERE sale_id = ?1 ORDER BY created_at, id")
		.bind(saleId)
		.all<{ id: string; item_id: string | null; actor_id: string; action: string; data: string; created_at: number }>();
	return results.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
}

/** Places a claim (or an offer with an amount). */
export function claim(sale: SaleSetup, buyerId: string, itemId = sale.itemIds[0]!) {
	return engine.placeEntry({ saleId: sale.saleId, itemId, buyerId, kind: "claim" });
}

export function offer(sale: SaleSetup, buyerId: string, amountCents: number, itemId = sale.itemIds[0]!) {
	return engine.placeEntry({ saleId: sale.saleId, itemId, buyerId, kind: "offer", amountCents });
}

export const entryOf = (result: RpcResult<Outcome<{ entry: Entry | null }>>) => value(result).entry!;
