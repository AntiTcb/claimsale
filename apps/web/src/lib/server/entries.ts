import type { Db } from "@claimsale/db";
import type { ItemCommandResult, Outcome, RpcResult } from "@claimsale/engine";
import { accessFor, type AccessViewer } from "./sale-access.ts";
import { findSaleById } from "./sales.ts";

/**
 * Claims and offers from the web (`POST /api/sales/[saleId]/entries`). The web Worker
 * authenticates the buyer and checks they may see the sale (private sales, D5); the
 * SaleEngine decides everything else (STATE_MACHINES §4.1) under the item's lock.
 */

export type EntriesBinding = Pick<Env["ENGINE"], "placeEntry">;

export interface PlaceEntryBody {
	readonly itemId: string;
	readonly kind: "claim" | "offer";
	readonly amountCents?: number;
}

/** Parses the JSON body; undefined when it isn't a claim or an offer. */
export function parsePlaceEntry(body: unknown): PlaceEntryBody | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const { itemId, kind, amountCents }: Record<string, unknown> = Object.fromEntries(Object.entries(body));
	if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 64) return undefined;
	if (kind === "claim") return { itemId, kind };
	if (
		kind === "offer" &&
		typeof amountCents === "number" &&
		Number.isSafeInteger(amountCents) &&
		amountCents > 0
	) {
		return { itemId, kind, amountCents };
	}
	return undefined;
}

export interface EntryResponse {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
	not_found: 404,
	rate_limited: 429,
	email_not_verified: 403,
	account_too_new: 403,
	buyer_blocked: 403,
	not_allowed: 403,
};

export async function placeEntry(
	deps: { readonly db: Db; readonly secret: string; readonly engine: EntriesBinding },
	viewer: AccessViewer,
	saleId: string,
	body: unknown,
): Promise<EntryResponse> {
	if (!viewer.user) return { status: 401, body: { code: "sign_in", message: "Sign in to claim" } };
	const input = parsePlaceEntry(body);
	if (!input)
		return { status: 400, body: { code: "invalid_input", message: "Send an item and a claim or an offer" } };
	const sale = await findSaleById(deps.db, saleId);
	if (!sale || (await accessFor(deps.db, deps.secret, sale, viewer)) !== "ok") {
		return { status: 404, body: { code: "not_found", message: "No such sale" } };
	}
	const result = (await deps.engine.placeEntry({
		saleId,
		itemId: input.itemId,
		buyerId: viewer.user.id,
		kind: input.kind,
		...(input.amountCents === undefined ? {} : { amountCents: input.amountCents }),
	})) as RpcResult<Outcome<ItemCommandResult>>;
	if (!result.ok) {
		return { status: 503, body: { code: "engine_unavailable", message: "Try again in a moment" } };
	}
	const outcome = result.value;
	if (!outcome.ok) {
		return { status: STATUS_BY_CODE[outcome.error.code] ?? 409, body: { ...outcome.error } };
	}
	const { entry, item } = outcome.value;
	return {
		status: 201,
		body: {
			entry: entry && {
				id: entry.id,
				kind: entry.kind,
				status: entry.status,
				amountCents: entry.amountCents,
			},
			item: { id: item.id, state: item.state, version: item.version },
		},
	};
}
