import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { Entry, Millis } from "@claimsale/core";
import type { RpcResult } from "../src/runtime.ts";
import type { Outcome, SaleEngine } from "../src/sale-engine.ts";
import { D1SaleStorage } from "../src/sale/storage.ts";

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

/** The ID of the saved address {@link addAddress} gives a user. */
export const addressOf = (userId: string) => `addr_${userId}`;

/** A saved address for a buyer, to pay invoices with (SM-6-address-snapshot). */
export async function addAddress(userId: string, name = "Ash Ketchum") {
	await db
		.prepare(
			`INSERT INTO addresses (id, user_id, name, line1, line2, city, region, postal_code, country, is_default, created_at, updated_at)
			VALUES (?1, ?2, ?3, '1 Route 1', NULL, 'Pallet', 'CA', '94107', 'US', 1, 1, 1)`,
		)
		.bind(addressOf(userId), userId, name)
		.run();
	return addressOf(userId);
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

/**
 * A sale with items. Default: live since an hour ago, closing in two days, every item
 * with an approved photo and an approved timestamp photo (WS-F2), so publishing passes
 * the photo checks unless a test asks otherwise.
 */
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
		/** Each item's photo; "none" adds none. */
		photos?: PhotoState | "none";
		/** The sale's timestamp photo; "none" adds none. */
		timestamp?: PhotoState | "none";
	} = {},
): Promise<SaleSetup> {
	const now = Date.now();
	const sellerId =
		options.sellerId ?? (await addUser(uid("seller"), { sellerPro: options.sellerPro ?? false }));
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
		const photo = options.photos ?? "approved";
		if (photo !== "none") await addPhoto(saleId, sellerId, id, photo);
	}
	const timestamp = options.timestamp ?? "approved";
	if (timestamp !== "none") {
		const photoId = await addPhoto(saleId, sellerId, null, timestamp);
		await db.prepare("UPDATE sales SET timestamp_image_id = ?1 WHERE id = ?2").bind(photoId, saleId).run();
	}
	return { saleId, sellerId, itemIds };
}

export type PhotoState = "pending" | "approved" | "review" | "rejected";

/** A photo row in a given state; `itemId` null is the sale's timestamp photo. No R2 object. */
export async function addPhoto(saleId: string, sellerId: string, itemId: string | null, status: PhotoState) {
	const id = uid("img");
	await db
		.prepare(
			"INSERT INTO item_images (id, sale_id, item_id, seller_id, r2_key, content_type, bytes, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'image/jpeg', 1, ?6, 1)",
		)
		.bind(id, saleId, itemId, sellerId, `test/${id}.jpg`, status)
		.run();
	return id;
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

/**
 * Waits until D1 has every write the sale's engine committed (WS-N: with the local store,
 * D1 follows through an outbox). Tests that read D1 after a claim call this first, like any
 * reader of D1 would see the claim a moment later.
 */
export async function settle(saleId: string) {
	const result = await stubFor(saleId).settle(saleId);
	if (!result.ok) throw new Error(`settle failed: ${result.error.message}`);
	if (result.value > 0) throw new Error(`${result.value} outbox entries didn't reach D1`);
}

async function saleOfItem(itemId: string) {
	const row = await db
		.prepare("SELECT sale_id FROM items WHERE id = ?1")
		.bind(itemId)
		.first<{ sale_id: string }>();
	return row?.sale_id;
}

/**
 * A write straight to D1, behind the engine's back (old rows, a repair): D1 first gets what
 * the engine holds, then the engine reads the sale from D1 again (what an operator's
 * `rehydrate` does).
 */
export async function writeBehindEngine(saleId: string, sql: string, ...params: unknown[]) {
	await settle(saleId);
	await db
		.prepare(sql)
		.bind(...params)
		.run();
	const result = await stubFor(saleId).rehydrate(saleId);
	if (!result.ok) throw new Error(`rehydrate failed: ${result.error.message}`);
}

/** The d1 adapter, for tests of the unit of work itself. */
export const d1Storage = () => new D1SaleStorage(db, () => undefined, { publish: () => undefined });

export async function entriesOf(itemId: string) {
	const saleId = await saleOfItem(itemId);
	if (saleId) await settle(saleId);
	const { results } = await db
		.prepare("SELECT * FROM entries WHERE item_id = ?1 ORDER BY created_at, id")
		.bind(itemId)
		.all();
	return results;
}

export async function itemRow(itemId: string) {
	const saleId = await saleOfItem(itemId);
	if (saleId) await settle(saleId);
	return (await db.prepare("SELECT * FROM items WHERE id = ?1").bind(itemId).first())!;
}

export async function saleRow(saleId: string) {
	return (await db.prepare("SELECT * FROM sales WHERE id = ?1").bind(saleId).first())!;
}

export async function invoicesOf(saleId: string) {
	await settle(saleId);
	const { results } = await db
		.prepare("SELECT * FROM invoices WHERE sale_id = ?1 ORDER BY created_at, id")
		.bind(saleId)
		.all();
	const out: Array<Record<string, unknown> & { lines: Array<Record<string, unknown>> }> = [];
	for (const invoice of results) {
		const lines = await db
			.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ?1 ORDER BY created_at, id")
			.bind(invoice["id"])
			.all();
		out.push({ ...invoice, lines: lines.results });
	}
	return out;
}

export async function auditOf(saleId: string) {
	await settle(saleId);
	const { results } = await db
		.prepare("SELECT * FROM audit_log WHERE sale_id = ?1 ORDER BY created_at, id")
		.bind(saleId)
		.all<{
			id: string;
			item_id: string | null;
			actor_id: string;
			action: string;
			data: string;
			created_at: number;
		}>();
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
