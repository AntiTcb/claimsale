import { Cause, Layer } from "effect";
import { CloudflareTracerLayer, type WorkersTracing } from "./cloudflare-tracer.ts";
import { StructuredLoggerLayer, type LogMeta, type LogSink } from "./logger.ts";
import type { ErrorReporter } from "./sentry.ts";

export interface ObservabilityOptions {
	readonly meta: LogMeta;
	/** `tracing` from `cloudflare:workers`. */
	readonly tracing: WorkersTracing;
	readonly reporter: ErrorReporter;
	/** `waitUntil` from `cloudflare:workers`, so reports finish after the response. */
	readonly waitUntil: (promise: Promise<unknown>) => void;
	readonly sink?: LogSink;
}

/**
 * Everything a Worker's Effect programs need for observability: the JSON logger,
 * the Cloudflare tracing bridge, and defect reporting to Sentry tagged with the
 * root span's trace ID (TECH_STACK §4).
 */
export function ObservabilityLayer(options: ObservabilityOptions) {
	return Layer.mergeAll(
		StructuredLoggerLayer(options.meta, options.sink),
		CloudflareTracerLayer(options.tracing, {
			onDefect: (cause, span) => {
				options.waitUntil(
					options.reporter.capture(Cause.squash(cause), { traceId: span.traceId, spanId: span.spanId }),
				);
			},
		}),
	);
}
