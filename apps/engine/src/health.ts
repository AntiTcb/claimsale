import { Effect } from "effect";
import type { EngineEnv } from "./env.ts";

export interface HealthReport {
	readonly status: "ok" | "degraded";
	readonly service: "engine";
	readonly env: string;
	readonly version: string;
	readonly checks: {
		readonly d1: "ok" | "error";
		readonly durableObject: "ok" | "error";
	};
}

const checkD1 = (db: D1Database) =>
	Effect.tryPromise(() => db.prepare("SELECT count(*) AS n FROM app_meta").first<{ n: number }>()).pipe(
		Effect.as("ok" as const),
		Effect.tapCause((cause) => Effect.logError("health: d1 check failed", cause)),
		Effect.orElseSucceed(() => "error" as const),
	);

const checkDurableObject = (ns: EngineEnv["SALE_ENGINE"]) =>
	Effect.tryPromise(() => ns.get(ns.idFromName("__health__")).ping()).pipe(
		Effect.as("ok" as const),
		Effect.tapCause((cause) => Effect.logError("health: durable object check failed", cause)),
		Effect.orElseSucceed(() => "error" as const),
	);

export const health = (env: EngineEnv): Effect.Effect<HealthReport> =>
	Effect.gen(function* () {
		const [d1, durableObject] = yield* Effect.all([checkD1(env.DB), checkDurableObject(env.SALE_ENGINE)], {
			concurrency: "unbounded",
		});
		const status = d1 === "ok" && durableObject === "ok" ? "ok" : "degraded";
		return {
			status,
			service: "engine",
			env: env.APP_ENV,
			version: env.VERSION,
			checks: { d1, durableObject },
		} as const;
	}).pipe(Effect.withSpan("engine.health"));
