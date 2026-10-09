import { WorkerEntrypoint } from "cloudflare:workers";
import type { EngineEnv } from "./env.ts";
import { handleQueue, handleScheduled } from "./handlers.ts";
import { health, type HealthReport } from "./health.ts";
import { run } from "./runtime.ts";

export { SaleEngine } from "./sale-engine.ts";
export type { HealthReport } from "./health.ts";
export type { EngineEnv } from "./env.ts";

/**
 * The engine Worker. The web Worker calls its methods over Workers RPC through a
 * service binding (TECH_STACK S3); it has no public routes.
 */
export default class Engine extends WorkerEntrypoint<EngineEnv> {
	override async fetch(): Promise<Response> {
		return new Response("Not found", { status: 404 });
	}

	async health(): Promise<HealthReport> {
		return run(this.env, health(this.env));
	}

	override async queue(batch: MessageBatch): Promise<void> {
		await run(this.env, handleQueue(batch));
	}

	override async scheduled(controller: ScheduledController): Promise<void> {
		await run(this.env, handleScheduled(controller));
	}
}
