import { Effect } from "effect";

/**
 * The engine's notification RPC (WS-K), as seen from the web Worker. Both calls are
 * best-effort: a message or an invite list is saved either way, and the user is never
 * shown an error because a notification couldn't be queued.
 */

type RpcResult<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly error: { readonly name: string; readonly message: string } };

/** The engine methods used here (the ENGINE service binding has them). */
export interface NotifyRpc {
	messagePosted(input: { messageId: string }): Promise<RpcResult<boolean>>;
	sendAllowlistInvites(input: { saleId: string; sellerId: string }): Promise<RpcResult<boolean>>;
	listingsChanged(input: { saleId: string; sellerId: string }): Promise<RpcResult<boolean>>;
	revokeLiveViewers(input: { saleId: string; sellerId: string }): Promise<RpcResult<boolean>>;
	buyerChanged(input: { userId: string; sellerId?: string }): Promise<RpcResult<number>>;
}

class NotifyRpcError extends Error {
	override readonly name = "NotifyRpcError";
}

const bestEffort = <A>(what: string, run: () => Promise<RpcResult<A>>) =>
	Effect.tryPromise({ try: run, catch: (cause) => new NotifyRpcError(String(cause)) }).pipe(
		Effect.flatMap((result) =>
			result.ok ? Effect.succeed(true) : Effect.fail(new NotifyRpcError(result.error.message)),
		),
		Effect.tapError((error) =>
			Effect.logWarning(`${what} not queued`).pipe(Effect.annotateLogs({ error: error.message })),
		),
		Effect.orElseSucceed(() => false),
	);

/** A message was stored: the engine notifies the other side (MSG-email-unread). */
export const notifyMessagePosted = (engine: NotifyRpc, messageId: string) =>
	bestEffort("message notification", () => engine.messagePosted({ messageId }));

/** The invite list of a published private sale was saved: invite the new addresses (NOTIF-allowlist-invite). */
export const requestAllowlistInvites = (engine: NotifyRpc, saleId: string, sellerId: string) =>
	bestEffort("allowlist invites", () => engine.sendAllowlistInvites({ saleId, sellerId }));

/**
 * The seller changed a published sale's items: open live grids refresh and the listings are
 * matched against want lists again (LIVE-broadcast, TCG-want-list-notify).
 */
export const refreshLiveListings = (engine: NotifyRpc, saleId: string, sellerId: string) =>
	bestEffort("live refresh", () => engine.listingsChanged({ saleId, sellerId }));

/**
 * A buyer's standing changed (blocked or unblocked by `sellerId`, banned, unbanned, Pro granted
 * or revoked): the sale engines that cached it read it again on the next claim.
 *
 * @spec SM-9-buyer-cache
 */
export const buyerStandingChanged = (engine: NotifyRpc, userId: string, sellerId?: string) =>
	bestEffort("buyer standing", () =>
		engine.buyerChanged(sellerId === undefined ? { userId } : { userId, sellerId }),
	);

/** A private sale's access changed: viewers other than the seller are disconnected (LIVE-access). */
export const revokeLiveAccess = (engine: NotifyRpc, saleId: string, sellerId: string) =>
	bestEffort("live access revoke", () => engine.revokeLiveViewers({ saleId, sellerId }));
