import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect } from "effect";
import { StructuredLoggerLayer, makeStructuredLogger, type LogMeta } from "./logger.ts";
import { Logger, References } from "effect";

const meta: LogMeta = { service: "engine", env: "test", version: "abc123" };

function capture() {
	const lines: Array<{ level: string; record: Record<string, unknown> }> = [];
	const layer = StructuredLoggerLayer(meta, (level, line) => {
		lines.push({ level, record: JSON.parse(line) as Record<string, unknown> });
	});
	return { lines, layer };
}

describe("StructuredLogger", () => {
	it.effect("writes one JSON record with the fixed fields", () => {
		const { lines, layer } = capture();
		return Effect.gen(function* () {
			yield* Effect.logInfo("sale published");
			expect(lines).toHaveLength(1);
			const { level, record } = lines[0]!;
			expect(level).toBe("info");
			expect(record).toMatchObject({
				level: "info",
				msg: "sale published",
				service: "engine",
				env: "test",
				version: "abc123",
			});
			expect(typeof record["ts"]).toBe("string");
		}).pipe(Effect.provide(layer));
	});

	it.effect("flattens annotations and redacts them", () => {
		const { lines, layer } = capture();
		return Effect.logWarning("login failed").pipe(
			Effect.annotateLogs({ sale_id: "s_1", email: "jane@example.com", password: "x", level: "spoof" }),
			Effect.provide(layer),
			Effect.tap(() =>
				Effect.sync(() => {
					expect(lines[0]!.record).toMatchObject({
						level: "warn",
						sale_id: "s_1",
						email: "***@example.com",
						password: "[redacted]",
						annotation_level: "spoof",
					});
				}),
			),
		);
	});

	it.effect("adds trace and span IDs inside a span", () => {
		const { lines, layer } = capture();
		return Effect.logInfo("in span").pipe(
			Effect.withSpan("engine.place_entry"),
			Effect.provide(layer),
			Effect.tap(() =>
				Effect.sync(() => {
					expect(lines[0]!.record["trace_id"]).toEqual(expect.any(String));
					expect(lines[0]!.record["span_id"]).toEqual(expect.any(String));
				}),
			),
		);
	});

	it.effect("includes a redacted cause for failures", () => {
		const { lines, layer } = capture();
		return Effect.fail(new Error("boom for a@b.co")).pipe(
			Effect.tapCause((cause) => Effect.logError("command failed", cause)),
			Effect.ignore,
			Effect.provide(layer),
			Effect.tap(() =>
				Effect.sync(() => {
					const { record } = lines[0]!;
					expect(record["level"]).toBe("error");
					expect(String(record["cause"])).toContain("boom for ***@b.co");
				}),
			),
		);
	});
});

describe("default console sink", () => {
	it.effect("routes each level to the matching console method", () => {
		const spies = {
			log: vi.spyOn(console, "log").mockImplementation(() => {}),
			warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
			error: vi.spyOn(console, "error").mockImplementation(() => {}),
			debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
		};
		return Effect.gen(function* () {
			yield* Effect.logInfo("i");
			yield* Effect.logWarning("w");
			yield* Effect.logError("e");
			yield* Effect.logFatal("f");
			yield* Effect.logDebug("d");
			yield* Effect.logTrace("t");
			expect(spies.log).toHaveBeenCalledTimes(1);
			expect(spies.warn).toHaveBeenCalledTimes(1);
			expect(spies.error).toHaveBeenCalledTimes(2);
			expect(spies.debug).toHaveBeenCalledTimes(2);
			expect(JSON.parse(String(spies.error.mock.calls[1]![0]))).toMatchObject({ level: "fatal", msg: "f" });
		}).pipe(
			Effect.provide(Logger.layer([makeStructuredLogger(meta)])),
			Effect.provideService(References.MinimumLogLevel, "All"),
			Effect.ensuring(Effect.sync(() => Object.values(spies).forEach((spy) => spy.mockRestore()))),
		);
	});

	it.effect("keeps multi-part messages as an array", () => {
		const { lines, layer } = capture();
		return Effect.log("a", 1).pipe(
			Effect.provide(layer),
			Effect.tap(() => Effect.sync(() => expect(lines[0]!.record["msg"]).toEqual(["a", 1]))),
		);
	});
});
