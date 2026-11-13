import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Tracer } from "effect";
import {
	CloudflareSpan,
	CloudflareTracerLayer,
	type WorkersSpan,
	type WorkersTracing,
} from "./cloudflare-tracer.ts";
import { StructuredLoggerLayer } from "./logger.ts";

interface FakeSpan extends WorkersSpan {
	readonly name: string;
	readonly parent: FakeSpan | undefined;
	readonly attributes: Record<string, unknown>;
	status?: { code: string; message?: string };
	exceptions: Array<{ name: string; message: string }>;
	ended: boolean;
}

/** A fake of the Workers tracing API, with an "active span" like the runtime's async context. */
function fakeTracing(options: { withActiveSpan?: boolean; spanContext?: boolean } = {}) {
	const spans: FakeSpan[] = [];
	let active: FakeSpan | undefined;
	let counter = 0;
	const startSpan = (name: string): FakeSpan => {
		counter += 1;
		const id = counter;
		const span: FakeSpan = {
			name,
			parent: active,
			attributes: {},
			exceptions: [],
			ended: false,
			setAttribute(key, value) {
				span.attributes[key] = value;
				return span;
			},
			end() {
				span.ended = true;
			},
			setStatus(status) {
				span.status = status;
				return span;
			},
			recordException(exception) {
				span.exceptions.push(exception);
			},
			...(options.spanContext === false
				? {}
				: {
						spanContext: () => ({
							traceId: "a".repeat(32),
							spanId: id.toString(16).padStart(16, "0"),
						}),
					}),
		};
		spans.push(span);
		return span;
	};
	const tracing: WorkersTracing = {
		startSpan,
		...(options.withActiveSpan === false
			? {}
			: {
					withActiveSpan<T>(span: WorkersSpan, fn: () => T): T {
						const previous = active;
						active = span as FakeSpan;
						try {
							return fn();
						} finally {
							active = previous;
						}
					},
				}),
	};
	/** Simulates a platform operation (e.g. a D1 query) recording a span under the active one. */
	const platformCall = (name: string) => Effect.sync(() => startSpan(name).end());
	return {
		tracing,
		spans,
		platformCall,
		byName: (name: string) => spans.find((span) => span.name === name)!,
	};
}

describe("CloudflareTracer", () => {
	it.effect("nests Effect spans and platform spans like the call tree", () => {
		const fake = fakeTracing();
		return Effect.gen(function* () {
			yield* fake
				.platformCall("d1.query")
				.pipe(Effect.withSpan("engine.inner"), Effect.withSpan("engine.outer"));
			const outer = fake.byName("engine.outer");
			const inner = fake.byName("engine.inner");
			expect(outer.parent).toBeUndefined();
			expect(inner.parent).toBe(outer);
			expect(fake.byName("d1.query").parent).toBe(inner);
			expect(outer.ended && inner.ended).toBe(true);
			expect(outer.status).toEqual({ code: "ok" });
		}).pipe(Effect.provide(CloudflareTracerLayer(fake.tracing)));
	});

	it.effect("uses the platform's trace and span IDs for Effect spans and log lines", () => {
		const fake = fakeTracing();
		const lines: Array<Record<string, unknown>> = [];
		const logger = StructuredLoggerLayer({ service: "engine", env: "test", version: "v" }, (_level, line) => {
			lines.push(JSON.parse(line) as Record<string, unknown>);
		});
		return Effect.gen(function* () {
			const span = yield* Effect.logInfo("hello").pipe(
				Effect.andThen(Effect.currentSpan),
				Effect.withSpan("engine.ids"),
			);
			expect(span.traceId).toBe("a".repeat(32));
			expect(span.spanId).toBe("0000000000000001");
			expect(lines[0]).toMatchObject({ trace_id: "a".repeat(32), span_id: "0000000000000001" });
		}).pipe(Effect.provide([CloudflareTracerLayer(fake.tracing), logger]));
	});

	it.effect("keeps Effect's own IDs when the runtime has no spanContext()", () => {
		const fake = fakeTracing({ spanContext: false });
		return Effect.gen(function* () {
			const [outer, inner] = yield* Effect.currentSpan.pipe(
				Effect.withSpan("inner"),
				Effect.flatMap((child) => Effect.map(Effect.currentSpan, (parent) => [parent, child] as const)),
				Effect.withSpan("outer"),
			);
			expect(outer.traceId).toMatch(/^[0-9a-f]{32}$/);
			expect(inner.traceId).toBe(outer.traceId);
			expect(inner.spanId).not.toBe(outer.spanId);
		}).pipe(Effect.provide(CloudflareTracerLayer(fake.tracing)));
	});

	it.effect("still records spans, unnested, when the runtime has no withActiveSpan()", () => {
		const fake = fakeTracing({ withActiveSpan: false });
		return Effect.gen(function* () {
			yield* fake.platformCall("d1.query").pipe(Effect.withSpan("inner"), Effect.withSpan("outer"));
			expect(fake.spans.map((span) => [span.name, span.parent?.name])).toEqual([
				["outer", undefined],
				["inner", undefined],
				["d1.query", undefined],
			]);
			expect(fake.spans.every((span) => span.ended)).toBe(true);
		}).pipe(Effect.provide(CloudflareTracerLayer(fake.tracing)));
	});

	it.effect("copies attributes with redaction and serializes non-primitive values", () => {
		const fake = fakeTracing();
		return Effect.void.pipe(
			Effect.withSpan("engine.attrs", {
				attributes: {
					sale_id: "s_1",
					count: 2,
					ok: true,
					email: "jane@example.com",
					meta: { a: 1 },
					big: 5n,
					none: undefined,
				},
			}),
			Effect.provide(CloudflareTracerLayer(fake.tracing)),
			Effect.tap(() =>
				Effect.sync(() => {
					const attrs = fake.byName("engine.attrs").attributes;
					expect(attrs).toMatchObject({
						sale_id: "s_1",
						count: 2,
						ok: true,
						email: "***@example.com",
						meta: '{"a":1}',
						big: "5",
						"span.kind": "internal",
					});
					expect(attrs).not.toHaveProperty("none");
				}),
			),
		);
	});

	it.effect("records links as attributes", () => {
		const fake = fakeTracing();
		const producer = Tracer.externalSpan({ traceId: "b".repeat(32), spanId: "c".repeat(16) });
		return Effect.gen(function* () {
			yield* Effect.void.pipe(Effect.withSpan("consumer", { links: [{ span: producer, attributes: {} }] }));
			yield* Effect.flatMap(Effect.currentSpan, (span) =>
				Effect.sync(() => span.addLinks([{ span: producer, attributes: {} }])),
			).pipe(Effect.withSpan("later"));
			expect(fake.byName("consumer").attributes).toMatchObject({
				"link.0.trace_id": "b".repeat(32),
				"link.0.span_id": "c".repeat(16),
			});
			expect(fake.byName("later").attributes).toMatchObject({ "link.0.trace_id": "b".repeat(32) });
		}).pipe(Effect.provide(CloudflareTracerLayer(fake.tracing)));
	});

	it.effect("marks expected failures without reporting them as defects", () => {
		const fake = fakeTracing();
		const defects: unknown[] = [];
		return Effect.fail("ItemSoldOut").pipe(
			Effect.withSpan("engine.place_entry"),
			Effect.flip,
			Effect.provide(CloudflareTracerLayer(fake.tracing, { onDefect: (cause) => defects.push(cause) })),
			Effect.tap(() =>
				Effect.sync(() => {
					const span = fake.byName("engine.place_entry");
					expect(span.status?.code).toBe("error");
					expect(span.attributes["error.expected"]).toBe(true);
					expect(span.exceptions).toEqual([]);
					expect(defects).toEqual([]);
				}),
			),
		);
	});

	it.effect("records defects as exceptions and reports them once, from the root span", () => {
		const fake = fakeTracing();
		const reported: Array<{ cause: Cause.Cause<unknown>; span: Tracer.Span }> = [];
		return Effect.die(new Error("boom for jane@example.com")).pipe(
			Effect.withSpan("inner"),
			Effect.withSpan("root"),
			Effect.exit,
			Effect.provide(
				CloudflareTracerLayer(fake.tracing, { onDefect: (cause, span) => reported.push({ cause, span }) }),
			),
			Effect.tap(() =>
				Effect.sync(() => {
					expect(fake.byName("inner").exceptions).toEqual([
						expect.objectContaining({ name: "Error", message: "boom for ***@example.com" }),
					]);
					expect(fake.byName("root").status?.message).not.toContain("jane@");
					expect(reported).toHaveLength(1);
					expect(reported[0]!.span.name).toBe("root");
					expect(reported[0]!.span).toBeInstanceOf(CloudflareSpan);
				}),
			),
		);
	});

	it.effect("records non-Error defects", () => {
		const fake = fakeTracing();
		return Effect.die({ reason: "bad" }).pipe(
			Effect.withSpan("root"),
			Effect.exit,
			Effect.provide(CloudflareTracerLayer(fake.tracing)),
			Effect.tap(() =>
				Effect.sync(() =>
					expect(fake.byName("root").exceptions).toEqual([{ name: "Error", message: '{"reason":"bad"}' }]),
				),
			),
		);
	});

	it.effect("leaves the status unset when a span is only interrupted", () => {
		const fake = fakeTracing();
		return Effect.interrupt.pipe(
			Effect.withSpan("root"),
			Effect.exit,
			Effect.provide(CloudflareTracerLayer(fake.tracing)),
			Effect.tap(() =>
				Effect.sync(() => {
					expect(fake.byName("root").status).toBeUndefined();
					expect(fake.byName("root").ended).toBe(true);
				}),
			),
		);
	});
});
