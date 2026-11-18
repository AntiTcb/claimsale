import { createDb, eq, type Db } from "@claimsale/db";
import { auditLog, users } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import {
	decideWindowRequest,
	pendingWindowRequests,
	requestLongerWindow,
	resetWindowCap,
	sellerWindow,
} from "./decision-window.ts";

const T = 1_800_000_000_000;
let db: Db;
const pro = { id: "seller", tier: "pro" as const };
const reason = "Weekly sales, buyers pay on Fridays";

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "admin");
	await addUser(db, "seller");
});

describe("longer decision windows", () => {
	it("[ADMIN-decision-window] a seller starts on the 7-day cap with no request", async () => {
		expect(await sellerWindow(db, "seller")).toEqual({ capHours: 168, approvedHours: null, request: null });
	});

	it("[ADMIN-decision-window] only Pro sellers ask, for more than their cap and at most 30 days, with a reason", async () => {
		expect(
			await requestLongerWindow(db, { ...pro, tier: "free" }, { hours: "336", reason }, T),
		).toMatchObject({
			ok: false,
			error: { code: "not_allowed" },
		});
		for (const hours of ["168", "721", "1.5", "x"]) {
			expect(await requestLongerWindow(db, pro, { hours, reason }, T)).toMatchObject({
				ok: false,
				error: { code: "invalid_hours" },
			});
		}
		expect(await requestLongerWindow(db, pro, { hours: "336", reason: "short" }, T)).toMatchObject({
			ok: false,
			error: { code: "invalid_reason" },
		});
		expect(await requestLongerWindow(db, pro, { hours: " 336 ", reason }, T)).toMatchObject({ ok: true });
		expect((await sellerWindow(db, "seller")).request).toEqual({ hours: 336, reason, requestedAt: T });
		expect(await pendingWindowRequests(db)).toMatchObject([
			{ userId: "seller", hours: 336, capHours: 168, requestedAt: T },
		]);
	});

	it("[ADMIN-decision-window] approving sets the cap to the requested hours and is audit-logged", async () => {
		await requestLongerWindow(db, pro, { hours: "336", reason }, T);
		expect(
			await decideWindowRequest(db, { userId: "seller", adminId: "admin", approve: true }, T + 1),
		).toMatchObject({
			ok: true,
		});
		expect(await sellerWindow(db, "seller")).toEqual({ capHours: 336, approvedHours: 336, request: null });
		expect(await pendingWindowRequests(db)).toEqual([]);
		// A new request must go above the approved cap.
		expect(await requestLongerWindow(db, pro, { hours: "336", reason }, T + 2)).toMatchObject({
			ok: false,
			error: { code: "invalid_hours" },
		});
		expect(await resetWindowCap(db, { userId: "seller", adminId: "admin" }, T + 3)).toMatchObject({
			ok: true,
		});
		expect((await sellerWindow(db, "seller")).capHours).toBe(168);
		expect(await resetWindowCap(db, { userId: "seller", adminId: "admin" }, T + 4)).toMatchObject({
			ok: false,
		});
		const actions = (await db.select().from(auditLog).all()).map((a) => [a.action, a.data]);
		expect(actions).toEqual([
			["admin_window_approve", { userId: "seller", hours: 336 }],
			["admin_window_reset", { userId: "seller" }],
		]);
	});

	it("[ADMIN-decision-window] declining clears the request and leaves the cap", async () => {
		await requestLongerWindow(db, pro, { hours: "500", reason }, T);
		expect(
			await decideWindowRequest(db, { userId: "seller", adminId: "admin", approve: false }, T + 1),
		).toMatchObject({
			ok: true,
		});
		expect(await sellerWindow(db, "seller")).toEqual({ capHours: 168, approvedHours: null, request: null });
		expect(
			await decideWindowRequest(db, { userId: "seller", adminId: "admin", approve: false }, T + 2),
		).toMatchObject({
			ok: false,
			error: { code: "no_request" },
		});
	});

	it("[ADMIN-decision-window] an approved cap is never read above 30 days", async () => {
		await db.update(users).set({ decisionWindowMaxHours: 5000 }).where(eq(users.id, "seller"));
		expect((await sellerWindow(db, "seller")).capHours).toBe(720);
	});
});
