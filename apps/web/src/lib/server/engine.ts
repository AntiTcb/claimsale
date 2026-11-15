import {
	publish as publishSale,
	unpublish as unpublishSale,
	ok,
	reject,
	type Millis,
	type Rejection,
	type Result,
	type Sale,
	type SaleRejection,
	type SaleStatus,
} from "@claimsale/core";
import { and, eq, sql, type Db } from "@claimsale/db";
import { auditLog, sales } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";
import { entitlements } from "./entitlements.ts";
import { countItems, itemsWithoutPhotos } from "./items.ts";
import { countActiveSales } from "./sales.ts";

/**
 * The web Worker's view of the sale engine (STATE_MACHINES §9). Every sale
 * transition goes through this interface. Today `localEngine` runs the core
 * transition and writes D1 directly; WS-E swaps in an implementation that calls
 * the SaleEngine Durable Object over RPC (which owns the alarm at `liveAt`), and
 * callers don't change.
 */

export interface PublishRequest {
	readonly saleId: string;
	readonly sellerId: string;
	/** Null publishes now (SM-2-publish-now). */
	readonly liveAt: Millis | null;
	readonly closesAt: Millis;
}

export type EngineRejection = SaleRejection | Rejection<"not_found" | "missing_photos" | "conflict">;

export interface PublishOutcome {
	readonly status: SaleStatus;
	readonly liveAt: Millis | null;
	readonly closesAt: Millis | null;
}

export interface Engine {
	publish(request: PublishRequest, now: Millis): Promise<Result<PublishOutcome, EngineRejection>>;
	unpublish(
		request: { saleId: string; sellerId: string },
		now: Millis,
	): Promise<Result<PublishOutcome, EngineRejection>>;
}

async function loadSale(db: Db, saleId: string, sellerId: string, now: Millis) {
	const row = await db
		.select()
		.from(sales)
		.where(and(eq(sales.id, saleId), eq(sales.sellerId, sellerId)))
		.get();
	if (!row || row.status === "deleted") return undefined;
	const tier = (await entitlements(db, sellerId, now)).seller;
	const sale: Sale = {
		status: row.status,
		liveAt: row.liveAt,
		closesAt: row.closesAt,
		sellerTier: tier,
		itemCount: await countItems(db, saleId),
	};
	return { row, sale };
}

/**
 * Applies a sale transition with a status check (a concurrent change makes the
 * update match no row) and its audit row in one batch (SM-9-audit, done fully by WS-E).
 */
async function commit(
	db: Db,
	saleId: string,
	expected: SaleStatus,
	next: Sale,
	actorId: string,
	action: string,
	now: Millis,
): Promise<Result<PublishOutcome, EngineRejection>> {
	const [updated] = await db.batch([
		db
			.update(sales)
			.set({
				status: next.status,
				liveAt: next.liveAt,
				closesAt: next.closesAt,
				...(action === "sale_published" ? { publishedAt: now } : {}),
				updatedAt: now,
			})
			.where(and(eq(sales.id, saleId), eq(sales.status, expected)))
			.returning({ id: sales.id }),
		// Written only if the update above applied (same batch, so same transaction).
		db.insert(auditLog).select(
			db
				.select({
					id: sql<string>`${uuidv7()}`.as("id"),
					saleId: sales.id,
					itemId: sql<null>`NULL`.as("item_id"),
					actorId: sql<string>`${actorId}`.as("actor_id"),
					action: sql<string>`${action}`.as("action"),
					data: sql<string>`${JSON.stringify({ status: next.status, liveAt: next.liveAt, closesAt: next.closesAt })}`.as(
						"data",
					),
					createdAt: sql<number>`${now}`.as("created_at"),
				})
				.from(sales)
				.where(and(eq(sales.id, saleId), eq(sales.status, next.status), eq(sales.updatedAt, now))),
		),
	]);
	if (updated.length === 0) {
		return reject("conflict", "The sale changed while you were publishing it. Reload and try again.");
	}
	return ok({ status: next.status, liveAt: next.liveAt, closesAt: next.closesAt });
}

/** The stub engine: core transitions over D1, no Durable Object (replaced by WS-E). */
export function localEngine(db: Db): Engine {
	return {
		/**
		 * @spec SM-2-publish-scheduled — a future go-live time schedules the sale (claims stay closed).
		 * @spec SM-2-publish-now — no go-live time makes it live now.
		 * @spec SM-2-preview-window — go-live at most 7 days ahead.
		 * @spec SM-2-free-sale-cap — at most 2 scheduled or live sales for free sellers.
		 * @spec SM-2-free-item-cap — at most 10 items, checked again on publish.
		 */
		async publish(request, now) {
			const loaded = await loadSale(db, request.saleId, request.sellerId, now);
			if (!loaded) return reject("not_found", "No such sale");
			// D63: every item needs a photo. WS-F2 tightens this to an approved one (IMG-required).
			if ((await itemsWithoutPhotos(db, request.saleId)).length > 0) {
				return reject("missing_photos", "Add at least one photo to every item before publishing");
			}
			const result = publishSale(
				loaded.sale,
				{
					liveAt: request.liveAt,
					closesAt: request.closesAt,
					activeSaleCount: await countActiveSales(db, request.sellerId, request.saleId),
				},
				now,
			);
			if (!result.ok) return result;
			return commit(db, request.saleId, "draft", result.value.sale, request.sellerId, "sale_published", now);
		},

		async unpublish(request, now) {
			const loaded = await loadSale(db, request.saleId, request.sellerId, now);
			if (!loaded) return reject("not_found", "No such sale");
			const result = unpublishSale(loaded.sale);
			if (!result.ok) return result;
			return commit(
				db,
				request.saleId,
				"scheduled",
				result.value.sale,
				request.sellerId,
				"sale_unpublished",
				now,
			);
		},
	};
}
