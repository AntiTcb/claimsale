import { describe, expect, it } from "@effect/vitest";
import type { TraceProbeResult } from "@claimsale/engine";
import { Effect } from "effect";
import { isProbeEnabled, probe, ProbeFailed } from "./trace-probe.ts";

const engineResult: TraceProbeResult = {
	probeId: "p1",
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
	queued: true,
	runtime: { spanContext: true, withActiveSpan: true },
};

function fakeEngine(outcome: Awaited<ReturnType<Parameters<typeof probe>[0]["traceProbe"]>>) {
	const calls: unknown[] = [];
	return {
		calls,
		engine: {
			traceProbe: async (input: unknown) => {
				calls.push(input);
				return outcome;
			},
		},
	};
}

describe("trace probe (web)", () => {
	it.effect("passes the decoded request to the engine and returns both hops' IDs", () => {
		const { engine, calls } = fakeEngine({ ok: true, value: engineResult });
		return Effect.gen(function* () {
			const result = yield* probe(engine, { fail: false });
			expect(calls).toEqual([{ fail: false }]);
			expect(result.engine).toEqual(engineResult);
			expect(result.web.traceId).toMatch(/^[0-9a-f]{32}$/);
			expect(result.web.spanId).toMatch(/^[0-9a-f]{16}$/);
		}).pipe(Effect.withSpan("web.trace_probe"));
	});

	it.effect("rejects an invalid request without calling the engine", () => {
		const { engine, calls } = fakeEngine({ ok: true, value: engineResult });
		return Effect.gen(function* () {
			const error = yield* Effect.flip(probe(engine, { fail: "yes" }));
			expect(error).toBeInstanceOf(ProbeFailed);
			expect(error.stage).toBe("request");
			expect(calls).toEqual([]);
		}).pipe(Effect.withSpan("web.trace_probe"));
	});

	it.effect("turns an engine failure into an expected failure, not a defect", () => {
		const { engine } = fakeEngine({ ok: false, error: { name: "Error", message: "deliberate failure" } });
		return Effect.gen(function* () {
			const error = yield* Effect.flip(probe(engine, { fail: true }));
			expect(error).toMatchObject({ _tag: "ProbeFailed", stage: "engine", message: "deliberate failure" });
		}).pipe(Effect.withSpan("web.trace_probe"));
	});

	it("is disabled in production only", () => {
		expect(isProbeEnabled("production")).toBe(false);
		expect(isProbeEnabled("staging")).toBe(true);
		expect(isProbeEnabled("preview")).toBe(true);
		expect(isProbeEnabled("local")).toBe(true);
	});
});
