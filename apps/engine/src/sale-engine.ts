import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { EngineEnv } from "./env.ts";
import { run, runForRpc, runtimeCapabilities, type RpcResult } from "./runtime.ts";
import { disabledProbe, isProbeEnabled, probeInDurableObject, type TraceProbeResult } from "./trace-probe.ts";

/**
 * One instance per sale (STATE_MACHINES §9). Milestone 0 only proves the binding,
 * RPC and alarms work; the per-item locks and transitions arrive in milestone 5.
 */
export class SaleEngine extends DurableObject<EngineEnv> {
	async ping(): Promise<"pong"> {
		return "pong";
	}

	/** The Durable Object hop of the T28 trace probe. */
	async traceProbe(input: unknown): Promise<RpcResult<TraceProbeResult>> {
		if (!isProbeEnabled(this.env)) return disabledProbe;
		return runForRpc(
			this.env,
			"engine.trace_probe.durable_object",
			probeInDurableObject(this.env, input, runtimeCapabilities()),
		);
	}

	override async alarm(): Promise<void> {
		await run(
			this.env,
			"engine.sale.alarm",
			Effect.logInfo("sale engine alarm fired").pipe(
				Effect.annotateLogs({ durable_object_id: this.ctx.id.toString() }),
			),
		);
	}
}
