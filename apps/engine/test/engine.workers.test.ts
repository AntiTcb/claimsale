import {
	createExecutionContext,
	createMessageBatch,
	createScheduledController,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { handleQueue, handleScheduled } from "../src/handlers.ts";

describe("engine health (RPC)", () => {
	it("reports ok when D1 is migrated and the Durable Object answers", async () => {
		const report = await exports.default.health();
		expect(report).toEqual({
			status: "ok",
			service: "engine",
			env: "test",
			version: "dev",
			checks: { d1: "ok", durableObject: "ok" },
		});
	});

	it("reports degraded, without throwing, when D1 is unusable", async () => {
		await env.DB.exec("DROP TABLE app_meta");
		const report = await exports.default.health();
		expect(report.status).toBe("degraded");
		expect(report.checks).toEqual({ d1: "error", durableObject: "ok" });
	});
});

describe("engine HTTP", () => {
	it("has no public routes", async () => {
		const res = await exports.default.fetch("https://engine.internal/anything");
		expect(res.status).toBe(404);
	});
});

describe("SaleEngine Durable Object", () => {
	it("answers ping over RPC", async () => {
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("sale_1"));
		expect(await stub.ping()).toBe("pong");
	});

	it("runs a scheduled alarm and logs it as JSON", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("sale_2"));
		await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
		expect(lines).toContainEqual(
			expect.objectContaining({ msg: "sale engine alarm fired", service: "engine", level: "info" }),
		);
		log.mockRestore();
	});
});

describe("queue consumer", () => {
	it("acknowledges every message", async () => {
		const batch = createMessageBatch("claimsale-notifications-local", [
			{ id: "m1", timestamp: new Date(), attempts: 1, body: { kind: "test" } },
		]);
		const ctx = createExecutionContext();
		await Effect.runPromise(handleQueue(batch));
		const result = await getQueueResult(batch, ctx);
		expect(result.ackAll).toBe(true);
		expect(result.retryBatch.retry).toBe(false);
	});
});

describe("cron sweep", () => {
	it("runs without error", async () => {
		const controller = createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" });
		await expect(Effect.runPromise(handleScheduled(controller))).resolves.toBeUndefined();
	});
});
