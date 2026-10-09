import type { HealthReport } from "@claimsale/engine";

export interface WebHealth {
	readonly status: "ok" | "degraded";
	readonly service: "web";
	readonly env: string;
	readonly version: string;
	readonly engine: HealthReport | { readonly status: "unreachable" };
}

/** Web health plus the engine's own report over RPC (TECH_STACK S3). */
export async function webHealth(env: Pick<Env, "APP_ENV" | "VERSION" | "ENGINE">): Promise<WebHealth> {
	let engine: WebHealth["engine"];
	try {
		engine = await env.ENGINE.health();
	} catch {
		engine = { status: "unreachable" };
	}
	return {
		status: engine.status === "ok" ? "ok" : "degraded",
		service: "web",
		env: env.APP_ENV,
		version: env.VERSION,
		engine,
	};
}
