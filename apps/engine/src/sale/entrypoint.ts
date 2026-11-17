import { reject } from "@claimsale/core";
import { Effect, Schema } from "effect";
import type { EngineEnv } from "../env.ts";
import { fromRpcResult, runForRpc, type RpcResult } from "../runtime.ts";
import type { WriterMethod } from "../sale-engine.ts";
import type { Outcome } from "./writer.ts";

/**
 * The Engine entrypoint's side of a sale command: validate the input, apply the
 * per-buyer rate limit if asked, and hand the command to the sale's SaleEngine.
 */


/**
 * Claims and offers per buyer are capped by the `ENTRY_LIMITER` Rate Limiting binding
 * (wrangler.jsonc), before the command reaches the Durable Object.
 *
 * @spec SM-9-entry-rate-limit — over the limit, the command is rejected with `rate_limited` and nothing is written.
 */
export async function withinRateLimit(env: Pick<EngineEnv, "ENTRY_LIMITER">, key: string): Promise<boolean> {
	const { success } = await env.ENTRY_LIMITER.limit({ key: `entry:${key}` });
	return success;
}

export const rateLimited = reject("rate_limited", "You're going too fast. Wait a few seconds and try again.");

export function saleCommand<S extends Schema.Constraint & { readonly Type: { readonly saleId: string } }, A>(
	env: EngineEnv,
	schema: S,
	method: WriterMethod,
	input: unknown,
	/** The user whose rate limit applies (claims and offers). */
	rateLimitKey?: (decoded: S["Type"]) => string,
): Promise<RpcResult<Outcome<A>>> {
	return runForRpc(
		env,
		`engine.rpc.${method}`,
		Effect.gen(function* () {
			const decoded = (yield* Schema.decodeUnknownEffect(schema)(input)) as S["Type"];
			const { saleId, ...rest } = decoded;
			yield* Effect.annotateCurrentSpan({ sale_id: saleId });
			if (rateLimitKey !== undefined) {
				const key = rateLimitKey(decoded);
				const allowed = yield* Effect.promise(() => withinRateLimit(env, key));
				if (!allowed) return rateLimited as Outcome<A>;
			}
			const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName(saleId));
			const result = yield* Effect.promise(
				async () => (await stub.command(saleId, method, rest)) as RpcResult<Outcome<unknown>>,
			);
			return (yield* fromRpcResult(result)) as Outcome<A>;
		}) as Effect.Effect<Outcome<A>, unknown, never>,
	);
}
