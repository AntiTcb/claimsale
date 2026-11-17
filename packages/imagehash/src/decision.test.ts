/**
 * The pure duplicate decision. The engine wiring (D1 band lookup, the verify Queue job,
 * publish blocking) is WS-F2 and gets its Workers integration tests there; these tests
 * cover the rule at the pure level.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decidePhoto, type PhotoDecision, REJECT_MAX_DISTANCE, REVIEW_MAX_DISTANCE } from "./decision.ts";
import type { MatchDistance } from "./image.ts";

const m = (dhash: number, phash: number): MatchDistance => ({ dhash, phash });
const distance = fc.integer({ min: 0, max: 64 });
const matchArb = fc.record({ dhash: distance, phash: distance });
const severity: Record<PhotoDecision, number> = { approved: 0, review: 1, rejected: 2 };

describe("decidePhoto", () => {
	it("uses the D65 thresholds", () => {
		expect(REJECT_MAX_DISTANCE).toBe(6);
		expect(REVIEW_MAX_DISTANCE).toBe(12);
	});

	it("[IMG-dup-reject] rejects a match within 6 on both hashes", () => {
		expect(decidePhoto([m(0, 0)])).toBe("rejected");
		expect(decidePhoto([m(6, 6)])).toBe("rejected");
		expect(decidePhoto([m(2, 6)])).toBe("rejected");
		expect(decidePhoto([m(40, 40), m(5, 3)])).toBe("rejected");
	});

	it("[IMG-dup-reject] does not reject when only one hash is that close", () => {
		expect(decidePhoto([m(6, 7)])).toBe("review");
		expect(decidePhoto([m(0, 13)])).toBe("approved");
	});

	it("[IMG-dup-review] holds a match at 7–12 (on both hashes) for review", () => {
		expect(decidePhoto([m(7, 7)])).toBe("review");
		expect(decidePhoto([m(12, 12)])).toBe("review");
		expect(decidePhoto([m(3, 12)])).toBe("review");
		expect(decidePhoto([m(30, 30), m(9, 11)])).toBe("review");
	});

	it("[IMG-dup-review] approves beyond 12 and with no other-seller matches", () => {
		expect(decidePhoto([])).toBe("approved");
		expect(decidePhoto([m(13, 13)])).toBe("approved");
		expect(decidePhoto([m(12, 13)])).toBe("approved");
	});

	it("[IMG-dup-reject] [IMG-dup-review] the most severe match wins, whatever the order", () => {
		fc.assert(
			fc.property(fc.array(matchArb, { maxLength: 8 }), matchArb, (matches, extra) => {
				const decision = decidePhoto(matches);
				// Order-independent.
				expect(decidePhoto(matches.toReversed())).toBe(decision);
				// Adding a match never makes the decision less severe.
				expect(severity[decidePhoto([...matches, extra])]).toBeGreaterThanOrEqual(severity[decision]);
				// Equals the most severe single-match decision.
				const worst = Math.max(0, ...matches.map((x) => severity[decidePhoto([x])]));
				expect(severity[decision]).toBe(worst);
			}),
		);
	});

	it("[IMG-dup-reject] [IMG-dup-review] a single match is decided by its larger distance", () => {
		fc.assert(
			fc.property(matchArb, (x) => {
				const worst = Math.max(x.dhash, x.phash);
				const expected = worst <= 6 ? "rejected" : worst <= 12 ? "review" : "approved";
				expect(decidePhoto([x])).toBe(expected);
			}),
		);
	});
});
