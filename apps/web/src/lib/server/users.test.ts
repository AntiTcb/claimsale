import { createDb, type Db } from "@claimsale/db";
import { users } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import {
	completeIdentity,
	findPublicProfile,
	isHandleAvailable,
	isUniqueViolation,
	updateProfile,
} from "./users.ts";

let db: Db;
const created = new Date("2026-11-01T00:00:00Z");

async function addUser(id: string, handle: string | null) {
	await db.insert(users).values({
		id,
		email: `${id}@example.test`,
		displayName: `User ${id}`,
		handle,
		createdAt: created,
		updatedAt: created,
	});
}

beforeEach(async () => {
	db = createDb(testD1());
	await addUser("u1", "ash");
	await addUser("u2", null);
});

describe("users repository", () => {
	it("finds a public profile by handle, case-insensitively, without private fields", async () => {
		const profile = await findPublicProfile(db, "ASH");
		expect(profile).toEqual({
			handle: "ash",
			displayName: "User u1",
			avatarUrl: null,
			fbProfileUrl: null,
			memberSince: created,
		});
		expect(Object.keys(profile ?? {})).not.toContain("email");
		expect(await findPublicProfile(db, "nobody")).toBeUndefined();
	});

	it("checks handle availability, ignoring the user's own handle", async () => {
		expect(await isHandleAvailable(db, "ash")).toBe(false);
		expect(await isHandleAvailable(db, "ash", "u1")).toBe(true);
		expect(await isHandleAvailable(db, "ash", "u2")).toBe(false);
		expect(await isHandleAvailable(db, "misty")).toBe(true);
	});

	it("completes identity and updates the profile", async () => {
		const now = new Date("2026-11-13T00:00:00Z");
		await completeIdentity(db, "u2", { handle: "misty", displayName: "Misty", ageAttested: "13+" }, now);
		const row = await db
			.select()
			.from(users)
			.where((await import("@claimsale/db")).eq(users.id, "u2"))
			.get();
		expect(row).toMatchObject({
			handle: "misty",
			displayName: "Misty",
			ageAttested: "13+",
			ageAttestedAt: now,
			updatedAt: now,
		});

		await updateProfile(
			db,
			"u2",
			{ handle: "misty_w", displayName: "Misty W", fbProfileUrl: "https://www.facebook.com/misty" },
			now,
		);
		expect(await findPublicProfile(db, "misty_w")).toMatchObject({
			displayName: "Misty W",
			fbProfileUrl: "https://www.facebook.com/misty",
		});
	});

	it("reports a taken handle as a unique violation", async () => {
		const error = await updateProfile(
			db,
			"u2",
			{ handle: "ash", displayName: "X", fbProfileUrl: null },
			new Date(),
		).catch((e: unknown) => e);
		expect(isUniqueViolation(error)).toBe(true);
		expect(isUniqueViolation(new Error("something else"))).toBe(false);
		expect(isUniqueViolation("UNIQUE constraint failed: users.handle")).toBe(true);
	});
});
