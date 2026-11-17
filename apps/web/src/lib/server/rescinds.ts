import {
	contestOpenUntil,
	fromStored,
	mutualAnswerDueAt,
	ok,
	reject,
	type Millis,
	type Rejection,
	type RescindPhase,
	type RescindReasonCode,
	type Result,
} from "@claimsale/core";
import { asc, eq, type Db } from "@claimsale/db";
import { entries, items, rescinds, sales, users } from "@claimsale/db/schema";

/**
 * Rescind contests and answers (STATE_MACHINES §4.3.1): the buyer's list at
 * `/me/rescinds`, and the engine calls for the buyer's contest or answer and the
 * admin's resolution. The engine runs every transition; this module only finds the
 * rescind's sale (which addresses its engine) and passes the authenticated user's ID.
 */

export type RescindEngine = Pick<Env["ENGINE"], "resolveRescind" | "contestRescind" | "answerMutualRescind">;

const unavailable = () =>
	reject("engine_unavailable", "The sale engine didn't answer. Try again in a moment.");

/** The engine's answer as a Result; a defect on its side is a retryable rejection. */
export async function rescindCall(call: () => Promise<unknown>): Promise<Result<true, Rejection>> {
	let result: { ok: boolean; value?: { ok: boolean; error?: Rejection } };
	try {
		// The binding answers RpcResult<Outcome<RescindView>> (apps/engine/src/index.ts).
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion
		result = (await call()) as typeof result;
	} catch {
		return unavailable();
	}
	if (!result.ok || !result.value) return unavailable();
	if (result.value.ok) return ok(true);
	return result.value.error ? { ok: false, error: result.value.error } : unavailable();
}

/** The sale a rescind belongs to, and its buyer, or null. */
export async function locateRescind(
	db: Db,
	rescindId: string,
): Promise<{ saleId: string; buyerId: string } | null> {
	const row = await db
		.select({ saleId: items.saleId, buyerId: rescinds.buyerId })
		.from(rescinds)
		.innerJoin(entries, eq(entries.id, rescinds.entryId))
		.innerJoin(items, eq(items.id, entries.itemId))
		.where(eq(rescinds.id, rescindId))
		.get();
	return row ?? null;
}

const notFound = () => reject("not_found", "No such rescind");

/**
 * The admin resolves a contested or held rescind; the engine re-checks the admin role.
 *
 * @spec SM-4.3.1-contest
 * @spec SM-4.3.1-fraud-review
 */
export async function resolveDispute(
	db: Db,
	engine: RescindEngine,
	input: { rescindId: string; adminId: string; fault: string; note: string },
): Promise<Result<true, Rejection>> {
	const { fault } = input;
	if (fault !== "buyer" && fault !== "seller" && fault !== "neutral") {
		return reject("invalid_input", "Pick buyer, seller or neutral");
	}
	const located = await locateRescind(db, input.rescindId);
	if (!located) return notFound();
	return rescindCall(() =>
		engine.resolveRescind({
			saleId: located.saleId,
			rescindId: input.rescindId,
			adminId: input.adminId,
			fault,
			note: input.note.trim() || null,
		}),
	);
}

/**
 * The buyer contests a rescind against them, giving their side.
 *
 * @spec SM-4.3.1-contest
 */
export async function contestAsBuyer(
	db: Db,
	engine: RescindEngine,
	input: { rescindId: string; buyerId: string; text: string },
): Promise<Result<true, Rejection>> {
	const located = await locateRescind(db, input.rescindId);
	// Someone else's rescind is "not found" too.
	if (!located || located.buyerId !== input.buyerId) return notFound();
	return rescindCall(() =>
		engine.contestRescind({
			saleId: located.saleId,
			rescindId: input.rescindId,
			buyerId: input.buyerId,
			text: input.text,
		}),
	);
}

/**
 * The buyer agrees to or disputes a mutual-agreement rescind.
 *
 * @spec SM-4.3.1-mutual
 */
export async function answerAsBuyer(
	db: Db,
	engine: RescindEngine,
	input: { rescindId: string; buyerId: string; agree: boolean },
): Promise<Result<true, Rejection>> {
	const located = await locateRescind(db, input.rescindId);
	if (!located || located.buyerId !== input.buyerId) return notFound();
	return rescindCall(() =>
		engine.answerMutualRescind({
			saleId: located.saleId,
			rescindId: input.rescindId,
			buyerId: input.buyerId,
			agree: input.agree,
		}),
	);
}

export interface BuyerRescind {
	readonly id: string;
	readonly saleTitle: string;
	readonly itemTitle: string;
	readonly sellerHandle: string | null;
	readonly reasonCode: RescindReasonCode;
	readonly explanation: string;
	readonly phase: RescindPhase;
	readonly refundOwed: boolean;
	readonly resolvedFault: string | null;
	readonly createdAt: Millis;
	/** Set while the buyer can still contest. */
	readonly contestUntil: Millis | null;
	/** Set while a mutual agreement waits for the buyer's answer. */
	readonly answerBy: Millis | null;
}

/** Seller rescinds of the buyer's wins, newest first: the reason and explanation are theirs to see (§4.3.1). */
export async function buyerRescinds(db: Db, buyerId: string, now: Millis): Promise<BuyerRescind[]> {
	const rows = await db
		.select({
			rescind: rescinds,
			saleTitle: sales.title,
			itemTitle: items.title,
			sellerHandle: users.handle,
		})
		.from(rescinds)
		.innerJoin(entries, eq(entries.id, rescinds.entryId))
		.innerJoin(items, eq(items.id, entries.itemId))
		.innerJoin(sales, eq(sales.id, items.saleId))
		.innerJoin(users, eq(users.id, rescinds.sellerId))
		.where(eq(rescinds.buyerId, buyerId))
		.orderBy(asc(rescinds.createdAt), asc(rescinds.id))
		.all();
	return rows
		.flatMap((row) => {
			const rescind = fromStored(row.rescind);
			if (!rescind) return [];
			return [
				{
					id: row.rescind.id,
					saleTitle: row.saleTitle,
					itemTitle: row.itemTitle,
					sellerHandle: row.sellerHandle,
					reasonCode: rescind.reasonCode,
					explanation: row.rescind.explanation,
					phase: rescind.phase,
					refundOwed: rescind.refundOwed,
					resolvedFault: rescind.resolvedFault,
					createdAt: rescind.createdAt,
					contestUntil: contestOpenUntil(rescind, now),
					answerBy: mutualAnswerDueAt(rescind),
				},
			];
		})
		.toReversed();
}
