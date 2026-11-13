import { formatTraceparent } from "@claimsale/observability";
import { Effect, Schema } from "effect";
import type { EngineEnv } from "./env.ts";
import type { RpcResult, RuntimeCapabilities } from "./runtime.ts";

/**
 * The T28 observability spike (TECH_STACK §4): one request that crosses every hop,
 * web → RPC → Durable Object → D1 → Queue → consumer → Email Service, so the whole
 * trace, its logs and a linked error can be checked in Sentry. Not available in
 * production.
 */

export const TraceProbeInput = Schema.Struct({
	/** Make the Durable Object hit a defect after its D1 query, to check error linking. */
	fail: Schema.optional(Schema.Boolean),
});
export type TraceProbeInput = typeof TraceProbeInput.Type;

export interface TraceProbeResult {
	readonly probeId: string;
	readonly traceId: string;
	readonly spanId: string;
	readonly queued: boolean;
	readonly runtime: RuntimeCapabilities;
}

export const disabledProbe = {
	ok: false,
	error: { name: "TraceProbeDisabled", message: "The trace probe is disabled in production" },
} as const satisfies RpcResult<never>;

export const isProbeEnabled = (env: Pick<EngineEnv, "APP_ENV">) => env.APP_ENV !== "production";

/** The Durable Object's part: a D1 query, then a queue message carrying `traceparent`. */
export const probeInDurableObject = (env: EngineEnv, input: unknown, runtime: RuntimeCapabilities) =>
	Effect.gen(function* () {
		const { fail } = yield* Schema.decodeUnknownEffect(TraceProbeInput)(input).pipe(Effect.orDie);
		const probeId = crypto.randomUUID();
		yield* Effect.annotateCurrentSpan({ probe_id: probeId });

		yield* Effect.tryPromise(() =>
			env.DB.prepare("SELECT count(*) AS n FROM app_meta").first<{ n: number }>(),
		).pipe(Effect.orDie, Effect.withSpan("engine.trace_probe.d1"));
		if (fail) return yield* Effect.die(new Error(`trace probe ${probeId}: deliberate failure`));

		const span = yield* Effect.currentSpan.pipe(Effect.orDie);
		const traceparent = formatTraceparent({ traceId: span.traceId, spanId: span.spanId, sampled: true });
		yield* Effect.tryPromise(() =>
			env.NOTIFICATIONS.send({
				kind: "trace_probe",
				probe_id: probeId,
				...(traceparent ? { traceparent } : {}),
			}),
		).pipe(Effect.orDie, Effect.withSpan("engine.trace_probe.enqueue"));
		yield* Effect.logInfo("trace probe enqueued").pipe(Effect.annotateLogs({ probe_id: probeId }));

		return {
			probeId,
			traceId: span.traceId,
			spanId: span.spanId,
			queued: true,
			runtime,
		} satisfies TraceProbeResult;
	});
