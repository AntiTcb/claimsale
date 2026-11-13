/**
 * W3C Trace Context `traceparent` values (https://www.w3.org/TR/trace-context/).
 * Queue messages carry one in their envelope so the consumer can link its span
 * to the producer's (TECH_STACK §4).
 */

export interface TraceContext {
	/** 32 lowercase hex characters, not all zeros. */
	readonly traceId: string;
	/** 16 lowercase hex characters, not all zeros. */
	readonly spanId: string;
	readonly sampled: boolean;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export function isValidTraceId(id: string): boolean {
	return /^[0-9a-f]{32}$/.test(id) && id !== ZERO_TRACE;
}

export function isValidSpanId(id: string): boolean {
	return /^[0-9a-f]{16}$/.test(id) && id !== ZERO_SPAN;
}

/** Formats a version-00 `traceparent`. Returns undefined for invalid IDs. */
export function formatTraceparent(context: TraceContext): string | undefined {
	if (!isValidTraceId(context.traceId) || !isValidSpanId(context.spanId)) return undefined;
	return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

/** Parses a `traceparent`; returns undefined when it is missing or malformed. */
export function parseTraceparent(value: unknown): TraceContext | undefined {
	if (typeof value !== "string") return undefined;
	const match = TRACEPARENT.exec(value.trim().toLowerCase());
	if (!match) return undefined;
	const [, version = "", traceId = "", spanId = "", flags = ""] = match;
	// Version ff is forbidden by the spec.
	if (version === "ff" || !isValidTraceId(traceId) || !isValidSpanId(spanId)) return undefined;
	return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}
