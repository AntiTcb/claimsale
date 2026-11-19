import type { Db } from "@claimsale/db";
import type { ItemCommandResult, Outcome, RpcResult } from "@claimsale/engine";
import { accessFor, type AccessViewer } from "./sale-access.ts";
import { findSaleById, type PublicSale } from "./sales.ts";

/**
 * Claims and offers from the web (`POST /api/sales/[saleId]/entries`). The web Worker
 * authenticates the buyer and checks they may see the sale (private sales, D5); the
 * SaleEngine decides everything else (STATE_MACHINES §4.1) under the item's lock.
 */

export type EntriesBinding = Pick<Env["ENGINE"], "placeEntry">;

// ---------------------------------------------------------------------------
// The sale lookup on the claim path (WS-N)

type GateSale = Pick<
	PublicSale,
	"id" | "sellerId" | "status" | "visibility" | "hasPassword" | "allowlistEnabled" | "passwordHash"
>;

/** How long a claim endpoint trusts a public or unlisted sale it looked up. */
export const SALE_GATE_TTL_MS = 5_000;

/**
 * The sale rows the claim and entry-action endpoints check access against, kept per
 * isolate for a few seconds so a go-live rush doesn't read D1 for the same sale on
 * every claim. Only public and unlisted sales are kept: a private sale is read every
 * time, so a password change or an allowlist removal applies at once. A sale that
 * stops being live meanwhile is still refused by the engine (`sale_not_live`).
 *
 * @spec SM-9-claim-access-cache
 */
export class SaleGateCache {
	readonly #rows = new Map<string, { readonly sale: GateSale; readonly at: number }>();

	constructor(readonly clock: () => number = Date.now) {}

	async get(db: Db, saleId: string): Promise<GateSale | undefined> {
		const now = this.clock();
		const hit = this.#rows.get(saleId);
		if (hit && now - hit.at < SALE_GATE_TTL_MS) return hit.sale;
		const sale = await findSaleById(db, saleId);
		if (sale && sale.visibility !== "private") {
			if (this.#rows.size >= 1_000) this.#rows.clear();
			this.#rows.set(saleId, { sale: gateOf(sale), at: now });
		} else {
			this.#rows.delete(saleId);
		}
		return sale && gateOf(sale);
	}
}

const gateOf = (sale: GateSale): GateSale => ({
	id: sale.id,
	sellerId: sale.sellerId,
	status: sale.status,
	visibility: sale.visibility,
	hasPassword: sale.hasPassword,
	allowlistEnabled: sale.allowlistEnabled,
	passwordHash: sale.passwordHash,
});

const isolateGates = new SaleGateCache();

async function canEnter(
	deps: { readonly db: Db; readonly secret: string; readonly gates?: SaleGateCache | undefined },
	viewer: AccessViewer,
	saleId: string,
): Promise<boolean> {
	const sale = await (deps.gates ?? isolateGates).get(deps.db, saleId);
	return sale !== undefined && (await accessFor(deps.db, deps.secret, sale, viewer)) === "ok";
}

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
	deps: {
		readonly db: Db;
		readonly secret: string;
		readonly engine: EntriesBinding;
		readonly gates?: SaleGateCache | undefined;
	},
	viewer: AccessViewer,
	saleId: string,
	body: unknown,
): Promise<EntryResponse> {
	if (!viewer.user) return { status: 401, body: { code: "sign_in", message: "Sign in to claim" } };
	const input = parsePlaceEntry(body);
	if (!input)
		return { status: 400, body: { code: "invalid_input", message: "Send an item and a claim or an offer" } };
	if (!(await canEnter(deps, viewer, saleId))) {
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

// ---------------------------------------------------------------------------
// A buyer's own entry: withdraw an offer, leave the backup queue, answer a counter (§4.4)

export type EntryActionsBinding = Pick<Env["ENGINE"], "withdrawEntry" | "respondToCounter">;

export const ENTRY_ACTIONS = ["withdraw_offer", "leave_queue", "accept_counter", "decline_counter"] as const;
export type EntryActionName = (typeof ENTRY_ACTIONS)[number];

export interface EntryActionBody {
	readonly itemId: string;
	readonly action: EntryActionName;
}

const isAction = (value: unknown): value is EntryActionName =>
	typeof value === "string" && (ENTRY_ACTIONS as readonly string[]).includes(value);

/** Parses `{ itemId, action }`; undefined for anything else. */
export function parseEntryAction(body: unknown): EntryActionBody | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const { itemId, action }: Record<string, unknown> = Object.fromEntries(Object.entries(body));
	if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 64) return undefined;
	return isAction(action) ? { itemId, action } : undefined;
}

/**
 * `POST /api/sales/[saleId]/entries/[entryId]`: the signed-in buyer acts on their own entry.
 * Access is checked as for placing; the engine checks the entry is theirs and the action is
 * allowed now (STATE_MACHINES §4.4), and its "no" comes back as `{ code, message }`.
 *
 * @spec SM-4.4-withdraw-offer
 * @spec SM-4.4-leave-backup
 * @spec SM-4.4-counter
 */
export async function entryAction(
	deps: {
		readonly db: Db;
		readonly secret: string;
		readonly engine: EntryActionsBinding;
		readonly gates?: SaleGateCache | undefined;
	},
	viewer: AccessViewer,
	saleId: string,
	entryId: string,
	body: unknown,
): Promise<EntryResponse> {
	if (!viewer.user) return { status: 401, body: { code: "sign_in", message: "Sign in first" } };
	const input = parseEntryAction(body);
	if (!input || entryId.length === 0 || entryId.length > 64)
		return { status: 400, body: { code: "invalid_input", message: "Send an item and an action" } };
	if (!(await canEnter(deps, viewer, saleId))) {
		return { status: 404, body: { code: "not_found", message: "No such sale" } };
	}
	const command = { saleId, itemId: input.itemId, entryId, buyerId: viewer.user.id };
	const result = (await (input.action === "withdraw_offer" || input.action === "leave_queue"
		? deps.engine.withdrawEntry(command)
		: deps.engine.respondToCounter({ ...command, accept: input.action === "accept_counter" }))) as RpcResult<
		Outcome<ItemCommandResult>
	>;
	if (!result.ok) {
		return { status: 503, body: { code: "engine_unavailable", message: "Try again in a moment" } };
	}
	const outcome = result.value;
	if (!outcome.ok) {
		return { status: STATUS_BY_CODE[outcome.error.code] ?? 409, body: { ...outcome.error } };
	}
	const { entry, item } = outcome.value;
	return {
		status: 200,
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
