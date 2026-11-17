import { createDb, type Db } from "@claimsale/db";
import { notifications } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import {
	listNotifications,
	markAllRead,
	markConversationNotificationsRead,
	openNotification,
	readEmailOff,
	saveEmailPreferences,
	unreadCount,
} from "./notifications.ts";

let db: Db;

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "ash");
	await addUser(db, "misty");
});

async function notify(
	id: string,
	userId: string,
	type: string,
	payload: Record<string, unknown>,
	createdAt = 1,
) {
	await db.insert(notifications).values({ id, userId, type, payload, createdAt });
}

describe("the bell", () => {
	it("counts and lists a user's notifications with their copy, newest first", async () => {
		await notify(
			"n1",
			"ash",
			"claim_won",
			{ saleSlug: "s", itemId: "i", itemTitle: "Mew", amountCents: 500 },
			1,
		);
		await notify(
			"n2",
			"ash",
			"followed_sale_live",
			{ saleSlug: "t", saleTitle: "Vintage", sellerName: "Brock" },
			2,
		);
		await notify("n3", "misty", "claim_won", {}, 3);
		expect(await unreadCount(db, "ash")).toBe(2);
		const list = await listNotifications(db, "ash");
		expect(list.map((n) => [n.id, n.title, n.path, n.read])).toEqual([
			["n2", "“Vintage” is live", "/s/t", false],
			["n1", "You won “Mew”", "/s/s/i/i", false],
		]);
	});

	it("opening a notification marks it read and returns its link; only its owner can", async () => {
		await notify("n1", "ash", "claim_won", { saleSlug: "s", itemId: "i" });
		expect(await openNotification(db, "misty", "n1", 10)).toBeUndefined();
		expect(await unreadCount(db, "ash")).toBe(1);
		expect(await openNotification(db, "ash", "n1", 10)).toBe("/s/s/i/i");
		expect(await unreadCount(db, "ash")).toBe(0);
		// Opening again keeps the first read time.
		await openNotification(db, "ash", "n1", 20);
		expect((await db.select().from(notifications).get())?.readAt).toBe(10);
	});

	it("marks everything read", async () => {
		await notify("n1", "ash", "claim_won", {});
		await notify("n2", "ash", "invoice_sent", {});
		await notify("n3", "misty", "invoice_sent", {});
		await markAllRead(db, "ash", 5);
		expect(await unreadCount(db, "ash")).toBe(0);
		expect(await unreadCount(db, "misty")).toBe(1);
	});

	it("an unknown stored type still lists", async () => {
		await notify("n1", "ash", "from_the_future", {});
		expect((await listNotifications(db, "ash"))[0]?.path).toBe("/me/notifications");
	});

	it("[MSG-email-unread] reading a conversation reads its message notifications only", async () => {
		await notify("m1", "ash", "new_message", { conversationId: "c1" });
		await notify("m2", "ash", "new_message", { conversationId: "c2" });
		await notify("w1", "ash", "claim_won", { conversationId: "c1" });
		await markConversationNotificationsRead(db, "ash", "c1", 9);
		const rows = await db
			.select({ id: notifications.id, readAt: notifications.readAt })
			.from(notifications)
			.all();
		expect(Object.fromEntries(rows.map((r) => [r.id, r.readAt]))).toEqual({ m1: 9, m2: null, w1: null });
	});
});

describe("email preferences", () => {
	it("[NOTIF-preferences] every category is on until the user turns one off", async () => {
		expect(await readEmailOff(db, "ash")).toEqual(new Set());
		await saveEmailPreferences(db, "ash", ["purchases", "messages", "made_up"], 1);
		expect(await readEmailOff(db, "ash")).toEqual(new Set(["selling", "followed_sellers", "want_list"]));
		await saveEmailPreferences(
			db,
			"ash",
			["purchases", "selling", "followed_sellers", "want_list", "messages"],
			2,
		);
		expect(await readEmailOff(db, "ash")).toEqual(new Set());
	});
});
