import {
	makeSentryReporter,
	ObservabilityLayer,
	type ErrorReporter,
	type LogMeta,
	type WorkersTracing,
} from "@claimsale/observability";
import { Effect, type Exit } from "effect";

/**
 * The web Worker's Effect runtime (TECH_STACK §3–4): the JSON logger, the
 * Cloudflare tracing bridge and Sentry defect reporting. It takes the runtime's
 * pieces as arguments so it can be unit-tested; runtime.ts wires in
 * `cloudflare:workers`.
 */

export interface WebRuntimeDeps {
	readonly env: { readonly APP_ENV: string; readonly VERSION: string; readonly SENTRY_DSN: string };
	readonly tracing: WorkersTracing & { getActiveSpan?(): SpanWithContext | undefined };
	readonly waitUntil: (promise: Promise<unknown>) => void;
}

export interface TraceIds {
	readonly traceId?: string;
	readonly spanId?: string;
}

interface SpanWithContext {
	spanContext?(): { traceId: string; spanId: string };
}

export function makeWebRuntime(deps: WebRuntimeDeps) {
	const logMeta = (): LogMeta => ({ service: "web", env: deps.env.APP_ENV, version: deps.env.VERSION });

	let cached: { key: string; reporter: ErrorReporter } | undefined;
	const reporter = (): ErrorReporter => {
		const key = `${deps.env.SENTRY_DSN}|${deps.env.APP_ENV}|${deps.env.VERSION}`;
		if (cached?.key !== key) {
			cached = { key, reporter: makeSentryReporter({ ...logMeta(), dsn: deps.env.SENTRY_DSN }) };
		}
		return cached.reporter;
	};

	/** The active Workers span's IDs, when the runtime exposes them. */
	const activeTraceIds = (): TraceIds => {
		const context = deps.tracing.getActiveSpan?.()?.spanContext?.();
		return context ? { traceId: context.traceId, spanId: context.spanId } : {};
	};

	return {
		logMeta,
		reporter,
		activeTraceIds,

		/** Runs a program in a root span named `span` and returns its exit; defects are reported to Sentry. */
		runExit: <A, E>(span: string, program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => {
			const layer = ObservabilityLayer({
				meta: logMeta(),
				tracing: deps.tracing,
				reporter: reporter(),
				waitUntil: deps.waitUntil,
			});
			return Effect.runPromise(Effect.exit(program.pipe(Effect.withSpan(span), Effect.provide(layer))));
		},

		/** Reports an error thrown outside an Effect program (SvelteKit's handleError). */
		reportError: (error: unknown, tags: Record<string, string>): void => {
			deps.waitUntil(reporter().capture(error, { ...activeTraceIds(), tags }));
		},
	};
}
