import { Cause, Context, Logger, Option, References, Tracer } from "effect";
import { redact } from "./redact.ts";

export type Service = "web" | "engine";

export interface LogMeta {
	readonly service: Service;
	/** `local`, `test`, `preview`, `staging` or `production`. */
	readonly env: string;
	/** Git SHA of the deployed build. */
	readonly version: string;
}

/** One JSON object per line; field names match span attributes (TECH_STACK §4). */
export interface LogRecord {
	readonly ts: string;
	readonly level: string;
	readonly msg: unknown;
	readonly service: Service;
	readonly env: string;
	readonly version: string;
	readonly trace_id?: string;
	readonly span_id?: string;
	readonly cause?: string;
	readonly [annotation: string]: unknown;
}

export type LogSink = (level: string, line: string) => void;

const consoleSink: LogSink = (level, line) => {
	if (level === "error" || level === "fatal") console.error(line);
	else if (level === "warn") console.warn(line);
	else if (level === "debug" || level === "trace") console.debug(line);
	else console.log(line);
};

const RESERVED = new Set(["ts", "level", "msg", "service", "env", "version", "trace_id", "span_id", "cause"]);

/** Builds the redacted record for one log call. Exported for tests. */
export function toRecord(meta: LogMeta, options: Logger.Options<unknown>): LogRecord {
	const level = options.logLevel.toLowerCase();
	const span = Context.getOption(options.fiber.context, Tracer.ParentSpan);
	const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
	const message =
		Array.isArray(options.message) && options.message.length === 1 ? options.message[0] : options.message;

	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(annotations)) {
		// Annotations can't overwrite the fixed fields.
		extra[RESERVED.has(key) ? `annotation_${key}` : key] = redact(value, key);
	}
	return {
		...extra,
		ts: options.date.toISOString(),
		level,
		msg: redact(message),
		service: meta.service,
		env: meta.env,
		version: meta.version,
		...(Option.isSome(span) ? { trace_id: span.value.traceId, span_id: span.value.spanId } : {}),
		...(options.cause.reasons.length > 0 ? { cause: String(redact(Cause.pretty(options.cause))) } : {}),
	};
}

export function makeStructuredLogger(meta: LogMeta, sink: LogSink = consoleSink) {
	return Logger.make((options) => {
		const record = toRecord(meta, options);
		sink(record.level, JSON.stringify(record));
	});
}

/** Replaces the default logger with the structured JSON logger. */
export const StructuredLoggerLayer = (meta: LogMeta, sink?: LogSink) =>
	Logger.layer([makeStructuredLogger(meta, sink)]);
