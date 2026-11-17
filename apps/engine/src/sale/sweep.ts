import { AUTOCOMPLETE_AFTER, type Millis } from "@claimsale/core";
import { Effect } from "effect";
import type { EngineEnv } from "../env.ts";
import type { RpcResult } from "../runtime.ts";
import type { SweepReport } from "../sale-engine.ts";
import { salesWithDueTimers } from "./timers.ts";

/**
 * The 5-minute cron sweep (STATE_MACHINES §7): the backstop for an alarm that was
 * lost or never set. It finds sales with a timer already due and asks each sale's
 * SaleEngine to run them, which also re-arms its alarm.
 *
 * @spec SM-7-single-alarm — a due timer is processed even if the sale's alarm was lost.
 */
export const sweepTimers = (env: Pick<EngineEnv, "DB" | "SALE_ENGINE">, now: Millis = Date.now()) =>
	Effect.gen(function* () {
		const saleIds = yield* Effect.promise(() => salesWithDueTimers(env.DB, now, AUTOCOMPLETE_AFTER));
		const results = yield* Effect.forEach(
			saleIds,
			(saleId) =>
				Effect.promise(
					async (): Promise<RpcResult<SweepReport>> =>
						await env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName(saleId)).sweep(saleId),
				).pipe(
					Effect.map((result) => (result.ok ? result.value.processed : 0)),
				),
			{ concurrency: 10 },
		);
		const processed = results.reduce((sum, n) => sum + n, 0);
		yield* Effect.logInfo("timer sweep done").pipe(
			Effect.annotateLogs({ sales: saleIds.length, timers_processed: processed }),
		);
		return { sales: saleIds.length, processed };
	});
