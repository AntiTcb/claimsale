import type { SaleEngine } from "./sale-engine.ts";

/**
 * The engine's bindings, declared explicitly instead of using the global `Env`
 * from `wrangler types`. Other Workers type-check this source through their
 * service bindings, and in their programs the global `Env` is theirs, not ours.
 * `env-check.ts` keeps this in sync with the generated type.
 */
export interface EngineEnv {
	readonly DB: D1Database;
	readonly SALE_ENGINE: DurableObjectNamespace<SaleEngine>;
	readonly NOTIFICATIONS: Queue;
	readonly APP_ENV: string;
	readonly VERSION: string;
}
