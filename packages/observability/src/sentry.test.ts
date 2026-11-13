import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { ObservabilityLayer } from "./layer.ts";
import {
	buildEvent,
	makeSentryReporter,
	parseDsn,
	parseStack,
	toEnvelope,
	type ErrorReporter,
} from "./sentry.ts";

const DSN = "https://abc123@o42.ingest.us.sentry.io/4507";
const options = { service: "engine", env: "staging", version: "sha1" } as const;

function fakeFetch(status = 200) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fn = vi.fn<typeof fetch>(async (url, init) => {
		calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
		return new Response(null, { status });
	});
	return { calls, fn };
}

function parseEnvelope(body: string) {
	const [header, itemHeader, item] = body.trimEnd().split("\n");
	return {
		header: JSON.parse(header!) as Record<string, unknown>,
		itemHeader: JSON.parse(itemHeader!) as Record<string, unknown>,
		event: JSON.parse(item!) as ReturnType<typeof buildEvent>,
	};
}

describe("parseDsn", () => {
	it("derives the envelope endpoint", () => {
		expect(parseDsn(DSN)).toEqual({
			publicKey: "abc123",
			host: "o42.ingest.us.sentry.io",
			projectId: "4507",
			envelopeUrl: "https://o42.ingest.us.sentry.io/api/4507/envelope/",
		});
	});

	it("keeps a path prefix for self-hosted Sentry", () => {
		expect(parseDsn("http://key@sentry.local:9000/sub/7")?.envelopeUrl).toBe(
			"http://sentry.local:9000/sub/api/7/envelope/",
		);
	});

	it.each([
		undefined,
		"",
		"not a url",
		"https://o1.ingest.sentry.io/1",
		"https://k@o1.ingest.sentry.io/",
		"ftp://k@h/1",
	])("rejects %j", (dsn) => {
		expect(parseDsn(dsn)).toBeUndefined();
	});
});

describe("parseStack", () => {
	it("parses V8 frames, oldest first, and marks dependencies as not in-app", () => {
		const stack = [
			"Error: boom",
			"    at inner (src/sale.ts:10:5)",
			"    at async outer (node_modules/effect/dist/x.js:1:2)",
			"    at src/index.ts:3:4",
			"    at <anonymous>",
		].join("\n");
		expect(parseStack(stack)).toEqual([
			{ filename: "src/index.ts", lineno: 3, colno: 4, in_app: true },
			{ function: "outer", filename: "node_modules/effect/dist/x.js", lineno: 1, colno: 2, in_app: false },
			{ function: "inner", filename: "src/sale.ts", lineno: 10, colno: 5, in_app: true },
		]);
	});

	it("returns no frames without a stack", () => {
		expect(parseStack(undefined)).toEqual([]);
	});
});

describe("buildEvent", () => {
	it("links the issue to the trace and redacts the message", () => {
		const error = new TypeError("no user jane@example.com");
		const event = buildEvent(error, options, {
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			tags: { route: "/x" },
		});
		expect(event).toMatchObject({
			platform: "javascript",
			level: "error",
			environment: "staging",
			release: "sha1",
			tags: { service: "engine", route: "/x", trace_id: "a".repeat(32) },
			contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) } },
			exception: { values: [{ type: "TypeError", value: "no user ***@example.com" }] },
		});
		expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
		expect(JSON.stringify(event)).not.toContain("jane@");
	});

	it("handles strings, objects and missing trace context", () => {
		expect(buildEvent("plain", options).exception.values[0]).toMatchObject({ type: "Error", value: "plain" });
		const event = buildEvent({ email: "a@b.co" }, options, { level: "fatal" });
		expect(event.exception.values[0]!.value).toBe('{"email":"***@b.co"}');
		expect(event.level).toBe("fatal");
		expect(event).not.toHaveProperty("contexts");
		expect(event.tags).toEqual({ service: "engine" });
	});
});

describe("makeSentryReporter", () => {
	it("is disabled without a DSN", async () => {
		const fetch = fakeFetch();
		const reporter = makeSentryReporter({ ...options, dsn: "", fetch: fetch.fn });
		expect(reporter.enabled).toBe(false);
		await reporter.capture(new Error("x"));
		expect(fetch.calls).toHaveLength(0);
	});

	it("posts one envelope with the auth header", async () => {
		const fetch = fakeFetch();
		const reporter = makeSentryReporter({ ...options, dsn: DSN, fetch: fetch.fn });
		await reporter.capture(new Error("boom"), { traceId: "c".repeat(32) });
		expect(fetch.calls).toHaveLength(1);
		const { url, init } = fetch.calls[0]!;
		expect(url).toBe("https://o42.ingest.us.sentry.io/api/4507/envelope/");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["x-sentry-auth"]).toContain("sentry_key=abc123");
		const envelope = parseEnvelope(init.body as string);
		expect(envelope.itemHeader).toEqual({ type: "event", content_type: "application/json" });
		expect(envelope.header["event_id"]).toBe(envelope.event.event_id);
		expect(envelope.event.tags["trace_id"]).toBe("c".repeat(32));
	});

	it("never rejects, and logs a failed send", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const rejected = makeSentryReporter({
			...options,
			dsn: DSN,
			fetch: () => Promise.reject(new Error("offline")),
		});
		await expect(rejected.capture(new Error("x"))).resolves.toBeUndefined();
		const status = makeSentryReporter({ ...options, dsn: DSN, fetch: fakeFetch(429).fn });
		await status.capture(new Error("x"));
		expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
			expect.objectContaining({ msg: "sentry: send failed", cause: "Error: offline" }),
			expect.objectContaining({ msg: "sentry: send failed", status: 429 }),
		]);
		error.mockRestore();
	});

	it("uses the global fetch current at send time, not at creation", async () => {
		const reporter = makeSentryReporter({ ...options, dsn: DSN });
		const later = fakeFetch();
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(later.fn);
		try {
			await reporter.capture(new Error("x"));
			expect(later.calls).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("serializes an envelope with three lines", () => {
		const envelope = toEnvelope(buildEvent(new Error("x"), options));
		expect(envelope.endsWith("\n")).toBe(true);
		expect(envelope.trimEnd().split("\n")).toHaveLength(3);
	});
});

describe("ObservabilityLayer", () => {
	it.effect("reports a root-span defect with its trace ID through waitUntil", () => {
		const captured: Array<{ error: unknown; traceId?: string | undefined }> = [];
		const pending: Array<Promise<unknown>> = [];
		const reporter: ErrorReporter = {
			enabled: true,
			capture: async (error, context) => {
				captured.push({ error, traceId: context?.traceId });
			},
		};
		const tracing = {
			startSpan: () => ({
				setAttribute: () => undefined,
				end: () => undefined,
				spanContext: () => ({ traceId: "d".repeat(32), spanId: "e".repeat(16) }),
			}),
		};
		const layer = ObservabilityLayer({
			meta: { service: "web", env: "test", version: "v" },
			tracing,
			reporter,
			waitUntil: (promise) => pending.push(promise),
			sink: () => {},
		});
		return Effect.die(new Error("kaput")).pipe(
			Effect.withSpan("web.request"),
			Effect.exit,
			Effect.provide(layer),
			Effect.andThen(Effect.promise(() => Promise.all(pending))),
			Effect.andThen(
				Effect.sync(() => {
					expect(pending).toHaveLength(1);
					expect(captured).toEqual([{ error: new Error("kaput"), traceId: "d".repeat(32) }]);
				}),
			),
		);
	});
});
