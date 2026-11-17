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
