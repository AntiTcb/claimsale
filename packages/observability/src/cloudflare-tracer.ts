import { Cause, Context, Exit, Layer, Option, Tracer } from "effect";
import type { Fiber } from "effect/Fiber";
import { redact } from "./redact.ts";
import { isValidSpanId, isValidTraceId } from "./traceparent.ts";

/**
 * The parts of a `cloudflare:workers` span the bridge uses. Methods added to the
 * runtime after 2026-10 are optional: local workerd builds can lack them, and the
 * bridge works without them (TECH_STACK §4, T28).
 */
export interface WorkersSpan {
	setAttribute(key: string, value: boolean | number | string): unknown;
	end(): void;
	spanContext?(): { readonly traceId: string; readonly spanId: string };
	recordException?(exception: { name: string; message: string; stack?: string }): void;
	setStatus?(status: { code: "unset" | "ok" | "error"; message?: string }): unknown;
}

/** The parts of `tracing` from `cloudflare:workers` the bridge uses. */
export interface WorkersTracing {
	startSpan(name: string): WorkersSpan;
	/** Runs `fn` with `span` as the active span, so spans started inside nest under it. */
	withActiveSpan?<T>(span: WorkersSpan, fn: () => T): T;
}

export interface CloudflareTracerOptions {
	/**
	 * Called once when a root span (one whose parent is not a bridged span) ends
	 * with a defect. Expected failures (`Effect.fail`) and interruptions are not
	 * reported (TECH_STACK §4: domain failures are logged, not raised as issues).
	 */
	readonly onDefect?: (cause: Cause.Cause<unknown>, span: Tracer.Span) => void;
}

// The fiber evaluates each primitive through this key; the tracer's `context` hook
// wraps that call (effect/internal/effect.js, `runLoop`).
const EVALUATE = "~effect/Effect/evaluate";

function evaluatePrimitive<X>(primitive: Tracer.EffectPrimitive<X>, fiber: Fiber<unknown, unknown>): X {
	const evaluate: unknown = Reflect.get(primitive, EVALUATE);
	if (typeof evaluate !== "function") throw new TypeError("Effect primitive has no evaluate method");
	// oxlint-disable-next-line typescript/no-unsafe-return -- the fiber's own call returns X (effect/internal/effect.js)
	return Reflect.apply(evaluate, primitive, [fiber]);
}

const MAX_ATTRIBUTE_LENGTH = 1024;
const MAX_STATUS_LENGTH = 512;

function toAttributeValue(key: string, value: unknown): boolean | number | string | undefined {
	if (value === undefined) return undefined;
	const safe = redact(value, key);
	if (typeof safe === "boolean" || typeof safe === "number" || typeof safe === "string") {
		return typeof safe === "string" ? safe.slice(0, MAX_ATTRIBUTE_LENGTH) : safe;
	}
	if (typeof safe === "bigint") return safe.toString();
	return JSON.stringify(safe).slice(0, MAX_ATTRIBUTE_LENGTH);
}

function toException(error: unknown): { name: string; message: string; stack?: string } {
	if (error instanceof Error) {
		const out = { name: error.name, message: String(redact(error.message)) };
		return error.stack === undefined ? out : { ...out, stack: String(redact(error.stack)) };
	}
	return {
		name: "Error",
		message: String(redact(typeof error === "string" ? error : JSON.stringify(error))),
	};
}

/** An Effect span that mirrors itself onto a Workers span. */
export class CloudflareSpan extends Tracer.NativeSpan {
	readonly workers: WorkersSpan;
	readonly #onDefect: CloudflareTracerOptions["onDefect"];

	constructor(
		options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
		workers: WorkersSpan,
		onDefect: CloudflareTracerOptions["onDefect"],
	) {
		super(options);
		this.workers = workers;
		this.#onDefect = onDefect;
		// Use the platform's IDs when it exposes them, so log lines and Sentry
		// issues carry the IDs of the exported trace. Otherwise keep Effect's.
		const context = workers.spanContext?.();
		if (context && isValidTraceId(context.traceId) && isValidSpanId(context.spanId)) {
			this._traceId = context.traceId;
			this._spanId = context.spanId;
		}
		this.workers.setAttribute("span.kind", options.kind);
	}

	get isRoot(): boolean {
		return !(Option.getOrUndefined(this.parent) instanceof CloudflareSpan);
	}

	override attribute(key: string, value: unknown): void {
		super.attribute(key, value);
		const safe = toAttributeValue(key, value);
		if (safe !== undefined) this.workers.setAttribute(key, safe);
	}

	override addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
		super.addLinks(links);
		this.#recordLinks(links);
	}

	/** Workers spans have no links API yet, so links become attributes. */
	recordInitialLinks(): void {
		this.#recordLinks(this.links);
	}

	#recordLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
		const offset = this.links.length - links.length;
		links.forEach((link, i) => {
			this.workers.setAttribute(`link.${offset + i}.trace_id`, link.span.traceId);
			this.workers.setAttribute(`link.${offset + i}.span_id`, link.span.spanId);
		});
	}

	override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
		super.end(endTime, exit);
		if (Exit.isSuccess(exit)) {
			this.workers.setStatus?.({ code: "ok" });
		} else if (!Cause.hasInterruptsOnly(exit.cause)) {
			const message = String(redact(Cause.pretty(exit.cause))).slice(0, MAX_STATUS_LENGTH);
			this.workers.setStatus?.({ code: "error", message });
			if (Cause.hasDies(exit.cause)) {
				this.workers.recordException?.(toException(Cause.squash(exit.cause)));
				if (this.isRoot) this.#onDefect?.(exit.cause, this);
			} else {
				this.workers.setAttribute("error.expected", true);
			}
		}
		this.workers.end();
	}
}

/**
 * An Effect `Tracer` that maps Effect spans onto Workers custom spans
 * (`cloudflare:workers` `tracing`), so they appear nested with the platform's
 * automatic spans (D1, RPC, Durable Objects, fetch) in the exported trace.
 *
 * Nesting needs `tracing.withActiveSpan`. Without it, every Effect span becomes a
 * child of the invocation's root span and platform spans don't nest under them.
 */
export function makeCloudflareTracer(
	tracing: WorkersTracing,
	options: CloudflareTracerOptions = {},
): Tracer.Tracer {
	const withActive = tracing.withActiveSpan?.bind(tracing);
	return Tracer.make({
		span(spanOptions) {
			const parent = Option.getOrUndefined(spanOptions.parent);
			const workers =
				withActive && parent instanceof CloudflareSpan
					? withActive(parent.workers, () => tracing.startSpan(spanOptions.name))
					: tracing.startSpan(spanOptions.name);
			const span = new CloudflareSpan(spanOptions, workers, options.onDefect);
			span.recordInitialLinks();
			return span;
		},
		context<X>(primitive: Tracer.EffectPrimitive<X>, fiber: Fiber<unknown, unknown>): X {
			const evaluate = (): X => evaluatePrimitive(primitive, fiber);
			if (!withActive) return evaluate();
			const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
			if (span instanceof CloudflareSpan && span.status._tag === "Started") {
				return withActive(span.workers, evaluate);
			}
			return evaluate();
		},
	});
}

/** Provides the bridge as the current tracer. */
export const CloudflareTracerLayer = (tracing: WorkersTracing, options?: CloudflareTracerOptions) =>
	Layer.succeed(Tracer.Tracer, makeCloudflareTracer(tracing, options));
