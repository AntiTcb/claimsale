import { describe, expect, it } from "vitest";
import { moveId } from "./reorder.ts";

describe("moveId", () => {
	const order = ["a", "b", "c", "d"];

	it("moves an item down or up, shifting the rest", () => {
		expect(moveId(order, "a", 2)).toEqual(["b", "c", "a", "d"]);
		expect(moveId(order, "d", 0)).toEqual(["d", "a", "b", "c"]);
		expect(moveId(order, "b", 2)).toEqual(["a", "c", "b", "d"]);
	});

	it("clamps the target and returns the same array when nothing moves", () => {
		expect(moveId(order, "a", -1)).toBe(order);
		expect(moveId(order, "d", 9)).toBe(order);
		expect(moveId(order, "c", 2)).toBe(order);
		expect(moveId(order, "zz", 0)).toBe(order);
		expect(moveId(order, "b", 99)).toEqual(["a", "c", "d", "b"]);
	});
});
