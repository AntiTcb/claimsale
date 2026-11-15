import { createDb, type Db } from "@claimsale/db";
import { rateLimits } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { consume } from "./rate-limit.ts";

let db: Db;
beforeEach(() => {
	db = createDb(testD1());
});

describe("consume", () => {
	const limit = { windowMs: 1000, max: 2 };

	it("allows `max` attempts per window, then refuses until the window ends", async () => {
		expect(await consume(db, "k", limit, 0)).toBe(true);
		expect(await consume(db, "k", limit, 500)).toBe(true);
		expect(await consume(db, "k", limit, 999)).toBe(false);
		// A refused attempt doesn't extend the window: it started at 0.
		expect(await consume(db, "k", limit, 1000)).toBe(true);
		expect(await consume(db, "k", limit, 1500)).toBe(true);
		expect(await consume(db, "k", limit, 1600)).toBe(false);
	});

	it("counts keys separately, under a prefix Better Auth's keys never use", async () => {
		expect(await consume(db, "a", { windowMs: 1000, max: 1 }, 0)).toBe(true);
		expect(await consume(db, "b", { windowMs: 1000, max: 1 }, 0)).toBe(true);
		expect(await consume(db, "a", { windowMs: 1000, max: 1 }, 1)).toBe(false);
		const keys = (await db.select({ key: rateLimits.key }).from(rateLimits).all()).map((r) => r.key);
		expect(keys.toSorted()).toEqual(["cs:a", "cs:b"]);
	});
});
