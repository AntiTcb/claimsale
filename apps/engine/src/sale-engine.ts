import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { EngineEnv } from "./env.ts";
import { run } from "./runtime.ts";

/**
 * One instance per sale (STATE_MACHINES §9). Milestone 0 only proves the binding,
 * RPC and alarms work; the per-item locks and transitions arrive in milestone 5.
 */
export class SaleEngine extends DurableObject<EngineEnv> {
	async ping(): Promise<"pong"> {
		return "pong";
	}

	override async alarm(): Promise<void> {
		await run(
			this.env,
			Effect.logInfo("sale engine alarm fired").pipe(
				Effect.annotateLogs({ durable_object_id: this.ctx.id.toString() }),
			),
		);
	}
}
