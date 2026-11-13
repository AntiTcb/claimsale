import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatTraceparent, parseTraceparent } from "./traceparent.ts";

const hex = (length: number) =>
	fc.string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: length, maxLength: length });

describe("traceparent", () => {
	it("formats and parses a sampled context", () => {
		const context = {
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanId: "00f067aa0ba902b7",
			sampled: true,
		};
		const header = formatTraceparent(context);
		expect(header).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
		expect(parseTraceparent(header)).toEqual(context);
	});

	it("round-trips any valid context", () => {
		fc.assert(
			fc.property(hex(32), hex(16), fc.boolean(), (traceId, spanId, sampled) => {
				fc.pre(/[1-9a-f]/.test(traceId) && /[1-9a-f]/.test(spanId));
				expect(parseTraceparent(formatTraceparent({ traceId, spanId, sampled }))).toEqual({
					traceId,
					spanId,
					sampled,
				});
			}),
		);
	});

	it("accepts uppercase, surrounding whitespace and unknown flag bits", () => {
		expect(parseTraceparent(" 00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-03 ")).toEqual({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanId: "00f067aa0ba902b7",
			sampled: true,
		});
	});

	it.each([
		["not a string", 42],
		["missing", undefined],
		["garbage", "hello"],
		["version ff", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
		["zero trace ID", `00-${"0".repeat(32)}-00f067aa0ba902b7-01`],
		["zero span ID", `00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`],
		["short trace ID", "00-4bf92f35-00f067aa0ba902b7-01"],
	])("rejects %s", (_label, value) => {
		expect(parseTraceparent(value)).toBeUndefined();
	});

	it("refuses to format invalid IDs", () => {
		expect(
			formatTraceparent({ traceId: "0".repeat(32), spanId: "00f067aa0ba902b7", sampled: true }),
		).toBeUndefined();
		expect(
			formatTraceparent({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "xyz", sampled: false }),
		).toBeUndefined();
	});
});
