import { StructuredLoggerLayer, type LogMeta } from "@claimsale/observability";
import { Effect } from "effect";
import type { EngineEnv } from "./env.ts";

export function logMeta(env: EngineEnv): LogMeta {
	return { service: "engine", env: env.APP_ENV, version: env.VERSION };
}

/** Runs an Effect program with the engine's structured logger. */
export function run<A, E>(env: EngineEnv, program: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(program.pipe(Effect.provide(StructuredLoggerLayer(logMeta(env)))));
}
