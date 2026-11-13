import { redact } from "./redact.ts";
import type { Service } from "./logger.ts";

/**
 * A minimal Sentry error reporter for Workers (TECH_STACK §4, T28 outcome).
 *
 * It posts one event per error to Sentry's envelope endpoint with `fetch`. The
 * event carries `contexts.trace`, so Sentry links the issue to the trace that
 * Cloudflare exports over OTLP. It replaces `@sentry/cloudflare` on the server:
 * see TECH_STACK S38 for why.
 */

export interface SentryDsn {
	readonly publicKey: string;
	readonly host: string;
	readonly projectId: string;
	readonly envelopeUrl: string;
}

/** Parses `https://<key>@<host>[/<path>]/<project>`. Returns undefined for an empty or invalid DSN. */
export function parseDsn(dsn: string | undefined): SentryDsn | undefined {
	if (!dsn) return undefined;
	let url: URL;
	try {
		url = new URL(dsn);
	} catch {
		return undefined;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const projectId = segments.pop();
	if (!url.username || !projectId || !/^\d+$/.test(projectId) || !/^https?:$/.test(url.protocol))
		return undefined;
	const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
	return {
		publicKey: url.username,
		host: url.host,
		projectId,
		envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
	};
}

export interface StackFrame {
	readonly function?: string;
	readonly filename?: string;
	readonly lineno?: number;
	readonly colno?: number;
	readonly in_app: boolean;
}

// "    at fn (file:1:2)", "    at file:1:2", "    at async fn (file:1:2)"
const V8_FRAME = /^\s*at (?:(?:async )?(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** Parses a V8 stack into Sentry frames, oldest call first. */
export function parseStack(stack: string | undefined): StackFrame[] {
	if (!stack) return [];
	const frames: StackFrame[] = [];
	for (const line of stack.split("\n")) {
		const match = V8_FRAME.exec(line);
		if (!match) continue;
		const [, fn, filename, lineno, colno] = match;
		frames.push({
			...(fn ? { function: fn } : {}),
			filename: filename!,
			lineno: Number(lineno),
			colno: Number(colno),
			in_app: !filename!.includes("node_modules"),
		});
	}
	return frames.toReversed();
}

export interface ReportContext {
	readonly traceId?: string | undefined;
	readonly spanId?: string | undefined;
	/** Low-cardinality tags, e.g. `{ route: "/api/health" }`. Values are redacted. */
	readonly tags?: Readonly<Record<string, string>> | undefined;
	readonly level?: "error" | "fatal" | "warning" | undefined;
}

export interface SentryEventOptions {
	readonly service: Service;
	readonly env: string;
	readonly version: string;
}

function eventId(): string {
	return crypto.randomUUID().replaceAll("-", "");
}

/** Builds a Sentry event; every string that could hold user data is redacted. */
export function buildEvent(error: unknown, options: SentryEventOptions, context: ReportContext = {}) {
	const err = error instanceof Error ? error : undefined;
	const type = err?.name ?? "Error";
	const value = String(
		redact(
			err
				? err.message
				: typeof error === "string"
					? error
					: (JSON.stringify(redact(error)) ?? String(error)),
		),
	);
	const frames = parseStack(err?.stack === undefined ? undefined : String(redact(err.stack)));
	const tags: Record<string, string> = { service: options.service };
	for (const [key, tagValue] of Object.entries(context.tags ?? {})) tags[key] = String(redact(tagValue, key));
	if (context.traceId) tags["trace_id"] = context.traceId;
	return {
		event_id: eventId(),
		timestamp: Date.now() / 1000,
		platform: "javascript",
		level: context.level ?? "error",
		environment: options.env,
		release: options.version,
		server_name: options.service,
		tags,
		...(context.traceId
			? {
					contexts: {
						trace: { trace_id: context.traceId, ...(context.spanId ? { span_id: context.spanId } : {}) },
					},
				}
			: {}),
		exception: {
			values: [
				{
					type,
					value,
					mechanism: { type: "generic", handled: false },
					...(frames.length > 0 ? { stacktrace: { frames } } : {}),
				},
			],
		},
	};
}

export type SentryEvent = ReturnType<typeof buildEvent>;

/** Serializes one event as an envelope (https://develop.sentry.dev/sdk/data-model/envelopes/). */
export function toEnvelope(event: SentryEvent): string {
	const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() });
	const item = JSON.stringify(event);
	return `${header}\n${JSON.stringify({ type: "event", content_type: "application/json" })}\n${item}\n`;
}

export interface ErrorReporter {
	/** Sends the error to Sentry. Never rejects; a failed send is written to the console. */
	capture(error: unknown, context?: ReportContext): Promise<void>;
	readonly enabled: boolean;
}

export interface SentryReporterOptions extends SentryEventOptions {
	readonly dsn: string | undefined;
	readonly fetch?: typeof fetch;
}

const disabled: ErrorReporter = { enabled: false, capture: () => Promise.resolve() };

/** A reporter for one Worker. With no DSN (local, tests, not set up yet), it does nothing. */
export function makeSentryReporter(options: SentryReporterOptions): ErrorReporter {
	const dsn = parseDsn(options.dsn);
	if (!dsn) return disabled;
	// Looked up per call, not captured: a cached reporter must follow the current global.
	const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
	const auth = `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=claimsale-reporter/1.0`;
	return {
		enabled: true,
		async capture(error, context) {
			try {
				const event = buildEvent(error, options, context);
				const response = await doFetch(dsn.envelopeUrl, {
					method: "POST",
					headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": auth },
					body: toEnvelope(event),
				});
				if (!response.ok)
					console.error(
						JSON.stringify({ level: "error", msg: "sentry: send failed", status: response.status }),
					);
			} catch (sendError) {
				console.error(
					JSON.stringify({
						level: "error",
						msg: "sentry: send failed",
						cause: String(redact(String(sendError))),
					}),
				);
			}
		},
	};
}
