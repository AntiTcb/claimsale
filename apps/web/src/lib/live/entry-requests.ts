import type { EntryAction } from "./state.ts";

/**
 * The browser's side of claiming and of acting on one's own entry, shared by the live grid
 * and the item page. Each returns ok (the socket, or a refetch without it, shows the result)
 * or the message to tell the buyer.
 */

export type RequestResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

async function post(
	url: string,
	body: Record<string, unknown>,
	okStatus: number,
	signIn: string,
): Promise<RequestResult> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (response.status === okStatus) return { ok: true };
		if (response.status === 401) return { ok: false, message: signIn };
		const answer: unknown = await response.json().catch(() => null);
		const message =
			answer !== null && typeof answer === "object" && "message" in answer ? answer.message : undefined;
		return {
			ok: false,
			message: typeof message === "string" ? message : "That didn't go through. Try again.",
		};
	} catch {
		return { ok: false, message: "You're offline. Try again in a moment." };
	}
}

/** A claim or an offer (`POST /api/sales/[saleId]/entries`). */
export function placeEntryRequest(
	saleId: string,
	itemId: string,
	kind: "claim" | "offer",
	amountCents?: number,
): Promise<RequestResult> {
	return post(
		`/api/sales/${encodeURIComponent(saleId)}/entries`,
		{ itemId, kind, ...(amountCents === undefined ? {} : { amountCents }) },
		201,
		"Sign in to claim.",
	);
}

/** Withdraw, leave the queue, or answer a counter (`POST /api/sales/[saleId]/entries/[entryId]`). */
export function entryActionRequest(
	saleId: string,
	itemId: string,
	entryId: string,
	action: EntryAction,
): Promise<RequestResult> {
	return post(
		`/api/sales/${encodeURIComponent(saleId)}/entries/${encodeURIComponent(entryId)}`,
		{ itemId, action },
		200,
		"Sign in first.",
	);
}
