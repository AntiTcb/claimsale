import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";
import type { EngineEnv } from "./env.ts";
import { handleQueue, handleScheduled } from "./handlers.ts";
import { health, type HealthReport } from "./health.ts";
import { CloudflareMailer } from "./mailer.ts";
import { fromRpcResult, optionalSecret, run, runForRpc, type RpcResult } from "./runtime.ts";
import { disabledProbe, isProbeEnabled, type TraceProbeInput, type TraceProbeResult } from "./trace-probe.ts";

export { SaleEngine } from "./sale-engine.ts";
export type { HealthReport } from "./health.ts";
export type { EngineEnv } from "./env.ts";
export type { RpcResult, RuntimeCapabilities } from "./runtime.ts";
export type { TraceProbeInput, TraceProbeResult } from "./trace-probe.ts";

/**
 * The engine Worker. The web Worker calls its methods over Workers RPC through a
 * service binding (TECH_STACK S3); it has no public routes.
 */
export default class Engine extends WorkerEntrypoint<EngineEnv> {
	override async fetch(): Promise<Response> {
		return new Response("Not found", { status: 404 });
	}

	async health(): Promise<HealthReport> {
		return run(this.env, "engine.health", health(this.env));
	}

	/** The T28 observability spike; see trace-probe.ts. */
	async traceProbe(input: TraceProbeInput): Promise<RpcResult<TraceProbeResult>> {
		if (!isProbeEnabled(this.env)) return disabledProbe;
		const stub = this.env.SALE_ENGINE.get(this.env.SALE_ENGINE.idFromName("__trace_probe__"));
		const callDurableObject = async (): Promise<RpcResult<TraceProbeResult>> => await stub.traceProbe(input);
		// A failed result is the Durable Object's defect, already reported there, so
		// it stays a failure here: one bug, one Sentry issue (see runForRpc()).
		return runForRpc(
			this.env,
			"engine.trace_probe",
			Effect.promise(callDurableObject).pipe(Effect.flatMap(fromRpcResult)),
		);
	}

	override async queue(batch: MessageBatch): Promise<void> {
		const options = { probeRecipient: optionalSecret(this.env, "TRACE_PROBE_TO") };
		await run(
			this.env,
			"engine.queue.notifications",
			handleQueue(batch, options).pipe(Effect.provide(CloudflareMailer(this.env.EMAIL, this.env.MAIL_FROM))),
		);
	}

	override async scheduled(controller: ScheduledController): Promise<void> {
		await run(this.env, "engine.cron.sweep", handleScheduled(controller));
	}
}
