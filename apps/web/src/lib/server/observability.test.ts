import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { makeWebRuntime } from "./observability.ts";

// A fake of the Workers runtime pieces (with spanContext(), like production).
function fakeWorkers() {
	const pending: Array<Promise<unknown>> = [];
	let active: { spanContext: () => { traceId: string; spanId: string } } | undefined;
	return {
		pending,
		setActive(traceId: string | undefined) {
			active = traceId ? { spanContext: () => ({ traceId, spanId: "1".repeat(16) }) } : undefined;
		},
		deps: {
			env: { APP_ENV: "test", VERSION: "v1", SENTRY_DSN: "https://key@sentry.example/7" },
			tracing: {
				startSpan: () => ({
					setAttribute: () => undefined,
					end: () => undefined,
					spanContext: () => ({ traceId: "f".repeat(32), spanId: "e".repeat(16) }),
				}),
				getActiveSpan: () => active,
			},
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise);
			},
		},
	};
}

function sentryEvents(fetchSpy: MockInstance<typeof fetch>) {
	return fetchSpy.mock.calls.map(([, init]) => {
		const lines = (init!.body as string).trimEnd().split("\n");
		return JSON.parse(lines[2]!) as {
			tags: Record<string, string>;
			exception: { values: Array<{ value: string }> };
		};
	});
}

describe("web runtime", () => {
	let fetchSpy: MockInstance<typeof fetch>;
	let workers: ReturnType<typeof fakeWorkers>;
	let runtime: ReturnType<typeof makeWebRuntime>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
		vi.spyOn(console, "log").mockImplementation(() => {});
		workers = fakeWorkers();
		runtime = makeWebRuntime(workers.deps);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("describes the web service for log lines", () => {
		expect(runtime.logMeta()).toEqual({ service: "web", env: "test", version: "v1" });
	});

	it("reuses one reporter while the configuration is unchanged", () => {
		expect(runtime.reporter()).toBe(runtime.reporter());
		expect(runtime.reporter().enabled).toBe(true);
	});

	it("runs a program in a root span and returns its exit", async () => {
		const exit = await runtime.runExit(
			"web.test",
			Effect.map(Effect.currentSpan, (span) => span.traceId),
		);
		expect(exit).toEqual(Exit.succeed("f".repeat(32)));
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reports a defect to Sentry with the span's trace ID", async () => {
		const exit = await runtime.runExit("web.test", Effect.die(new Error("web bug")));
		expect(Exit.isFailure(exit)).toBe(true);
		await Promise.all(workers.pending);
		expect(sentryEvents(fetchSpy)).toEqual([
			expect.objectContaining({
				tags: expect.objectContaining({ service: "web", trace_id: "f".repeat(32) }),
				exception: { values: [expect.objectContaining({ value: "web bug" })] },
			}),
		]);
	});

	it("does not report expected failures", async () => {
		const exit = await runtime.runExit("web.test", Effect.fail("ItemSoldOut"));
		expect(Exit.isFailure(exit)).toBe(true);
		await Promise.all(workers.pending);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reads the active span's IDs, or none without one", () => {
		expect(runtime.activeTraceIds()).toEqual({});
		workers.setActive("c".repeat(32));
		expect(runtime.activeTraceIds()).toEqual({ traceId: "c".repeat(32), spanId: "1".repeat(16) });
	});

	it("reports errors from outside Effect with tags and the active trace", async () => {
		workers.setActive("d".repeat(32));
		runtime.reportError(new Error("hook error"), { route: "/x", method: "GET" });
		await Promise.all(workers.pending);
		expect(sentryEvents(fetchSpy)[0]?.tags).toEqual({
			service: "web",
			route: "/x",
			method: "GET",
			trace_id: "d".repeat(32),
		});
	});
});
