import type { RpcResult, TraceProbeInput, TraceProbeResult } from "@claimsale/engine";
import { Data, Effect, Schema } from "effect";

/**
 * The web hop of the T28 observability spike (TECH_STACK §4): browser → web →
 * engine RPC → Durable Object → D1 → Queue → consumer → Email Service.
 */

export const ProbeRequest = Schema.Struct({ fail: Schema.optional(Schema.Boolean) });

export class ProbeFailed extends Data.TaggedError("ProbeFailed")<{
	readonly stage: "request" | "engine";
	readonly message: string;
}> {}

export interface WebProbeResult {
	readonly web: { readonly traceId: string; readonly spanId: string };
	readonly engine: TraceProbeResult;
}

type ProbeEngine = { traceProbe(input: TraceProbeInput): Promise<RpcResult<TraceProbeResult>> };

export const isProbeEnabled = (appEnv: string) => appEnv !== "production";

/**
 * Decodes the request body and calls the engine. Engine failures are failures
 * here, not defects: the engine already reported its own defect to Sentry.
 */
export const probe = (engine: ProbeEngine, body: unknown) =>
	Effect.gen(function* () {
		const input = yield* Schema.decodeUnknownEffect(ProbeRequest)(body).pipe(
			Effect.mapError((error) => new ProbeFailed({ stage: "request", message: error.message })),
		);
		const span = yield* Effect.currentSpan.pipe(Effect.orDie);
		const outcome = yield* Effect.promise(() => engine.traceProbe(input)).pipe(
			Effect.withSpan("web.trace_probe.rpc"),
		);
		if (!outcome.ok) return yield* new ProbeFailed({ stage: "engine", message: outcome.error.message });
		yield* Effect.logInfo("trace probe completed").pipe(
			Effect.annotateLogs({ probe_id: outcome.value.probeId }),
		);
		return {
			web: { traceId: span.traceId, spanId: span.spanId },
			engine: outcome.value,
		} satisfies WebProbeResult;
	});
