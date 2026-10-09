import { describe, expect, it } from "vitest";
import type { HealthReport } from "@claimsale/engine";
import { webHealth } from "./health.ts";

const okEngine: HealthReport = {
	status: "ok",
	service: "engine",
	env: "test",
	version: "abc",
	checks: { d1: "ok", durableObject: "ok" },
};

function envWith(health: () => Promise<HealthReport>) {
	return { APP_ENV: "test", VERSION: "abc", ENGINE: { health } } as unknown as Pick<
		Env,
		"APP_ENV" | "VERSION" | "ENGINE"
	>;
}

describe("webHealth", () => {
	it("is ok when the engine is ok", async () => {
		const report = await webHealth(envWith(async () => okEngine));
		expect(report).toEqual({ status: "ok", service: "web", env: "test", version: "abc", engine: okEngine });
	});

	it("is degraded when the engine is degraded", async () => {
		const degraded = {
			...okEngine,
			status: "degraded" as const,
			checks: { d1: "error" as const, durableObject: "ok" as const },
		};
		const report = await webHealth(envWith(async () => degraded));
		expect(report.status).toBe("degraded");
		expect(report.engine).toEqual(degraded);
	});

	it("is degraded, without throwing, when the engine is unreachable", async () => {
		const report = await webHealth(
			envWith(async () => {
				throw new Error("service binding failed");
			}),
		);
		expect(report).toMatchObject({ status: "degraded", engine: { status: "unreachable" } });
	});
});
