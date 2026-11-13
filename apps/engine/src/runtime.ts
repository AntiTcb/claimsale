import {
	makeSentryReporter,
	ObservabilityLayer,
	type ErrorReporter,
	type LogMeta,
} from "@claimsale/observability";
import { tracing, waitUntil } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";
import type { EngineEnv } from "./env.ts";

export function logMeta(env: EngineEnv): LogMeta {
	return { service: "engine", env: env.APP_ENV, version: env.VERSION };
}

// One reporter per isolate; the key changes only between test cases.
let cached: { key: string; reporter: ErrorReporter } | undefined;
function reporterFor(env: EngineEnv): ErrorReporter {
	const key = `${env.SENTRY_DSN}|${env.APP_ENV}|${env.VERSION}`;
	if (cached?.key !== key) {
		cached = { key, reporter: makeSentryReporter({ ...logMeta(env), dsn: env.SENTRY_DSN }) };
	}
	return cached.reporter;
}

// `waitUntil` from cloudflare:workers needs a newer workerd than some local test runtimes.
const defer = (promise: Promise<unknown>) =>
	typeof waitUntil === "function" ? waitUntil(promise) : void promise.catch(() => undefined);

/**
 * Runs an Effect program in a root span named `span` (`domain.action`), with the
 * JSON logger, the Cloudflare tracing bridge and Sentry defect reporting.
 *
 * A defect is reported by the Worker where it happens. A caller that gets an
 * error back over RPC treats it as a failure, so one bug makes one Sentry issue.
 */
export function run<A, E>(
	env: EngineEnv,
	span: string,
	program: Effect.Effect<A, E>,
	attributes?: Record<string, unknown>,
): Promise<A> {
	return Effect.runPromise(instrument(env, span, program, attributes));
}

function instrument<A, E>(
	env: EngineEnv,
	span: string,
	program: Effect.Effect<A, E>,
	attributes?: Record<string, unknown>,
) {
	return program.pipe(
		Effect.withSpan(span, attributes ? { attributes } : undefined),
		Effect.provide(
			ObservabilityLayer({ meta: logMeta(env), tracing, reporter: reporterFor(env), waitUntil: defer }),
		),
	);
}

/** A Durable Object RPC result. Errors cross as data, so the call never throws. */
export type RpcResult<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly error: { readonly name: string; readonly message: string } };

/**
 * Like run(), for Durable Object RPC methods: returns failures and defects as an
 * RpcResult instead of rejecting. A rejected Durable Object call ends that
 * invocation with an uncaught exception in Cloudflare's logs, on top of the
 * Sentry report this Worker already sent; the caller decides what a failure means.
 */
export async function runForRpc<A, E>(
	env: EngineEnv,
	span: string,
	program: Effect.Effect<A, E>,
	attributes?: Record<string, unknown>,
): Promise<RpcResult<A>> {
	// The exit is taken outside the root span, so the span still sees (and reports) a defect.
	const exit = await Effect.runPromise(Effect.exit(instrument(env, span, program, attributes)));
	if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
	const error = Cause.squash(exit.cause);
	return {
		ok: false,
		error:
			error instanceof Error
				? { name: error.name, message: error.message }
				: { name: "Error", message: String(error) },
	};
}

/** Turns an RpcResult back into a value, or a failure the caller can handle. */
export const fromRpcResult = <A>(result: RpcResult<A>): Effect.Effect<A, RpcError> =>
	result.ok ? Effect.succeed(result.value) : Effect.fail(new RpcError(result.error));

export class RpcError extends Error {
	constructor(error: { readonly name: string; readonly message: string }) {
		super(error.message);
		this.name = error.name;
	}
}

/**
 * Optional secrets, set with `wrangler secret put` and absent by default. They
 * are not in EngineEnv because `wrangler types` only knows declared secrets.
 */
export function optionalSecret(env: EngineEnv, name: "TRACE_PROBE_TO"): string | undefined {
	const value: unknown = Reflect.get(env, name);
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export interface RuntimeCapabilities {
	/** `span.spanContext()`: log lines and Sentry issues carry the exported trace's IDs. */
	readonly spanContext: boolean;
	/** `tracing.withActiveSpan()`: Effect spans nest, and platform spans nest under them. */
	readonly withActiveSpan: boolean;
}

/** What this runtime's tracing API supports (the T28 spike reports it). */
export function runtimeCapabilities(): RuntimeCapabilities {
	const api = tracing as Partial<typeof tracing>;
	return {
		spanContext: typeof api.Span?.prototype?.spanContext === "function",
		withActiveSpan: typeof api.withActiveSpan === "function",
	};
}
