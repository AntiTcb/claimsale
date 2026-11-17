import { createDb, type Db } from "@claimsale/db";
import { messageAttachments, reports } from "@claimsale/db/messaging";
import { sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, GPS_MARKER, jpegBytes, memoryStore } from "../../../test/fixtures.ts";
import {
	blockBuyer,
	closeReport,
	findAttachmentFor,
	findBuyerConversation,
	inbox,
	isBlocked,
	loadConversation,
	markRead,
	messagesOf,
	openConversation,
	openReports,
	postMessage,
	readMessageForm,
	reportMessage,
	unblockBuyer,
	type ConversationRow,
} from "./messaging.ts";

let db: Db;
const sale = { id: "sale-1", sellerId: "seller" };

beforeEach(async () => {
	db = createDb(testD1());
	for (const id of ["seller", "buyer", "other"]) await addUser(db, id);
	await db.insert(sales).values({
		id: sale.id,
		sellerId: sale.sellerId,
		slug: "weekend-ygo",
		title: "Weekend YGO",
		status: "live",
		createdAt: 1,
		updatedAt: 1,
	});
});

async function conversation(): Promise<ConversationRow> {
	const opened = await openConversation(db, sale, "buyer", 1);
	if (!opened.ok) throw new Error(opened.error.message);
	return opened.value;
}

const text = (body: string) => ({ body, images: [] });

describe("conversations", () => {
	it("[MSG-one-conversation] one conversation per buyer per sale, between the buyer and the seller", async () => {
		const a = await conversation();
		const b = await conversation();
		expect(b.id).toBe(a.id);
		expect(a).toMatchObject({ saleId: sale.id, buyerId: "buyer", sellerId: "seller" });
		expect((await findBuyerConversation(db, sale.id, "buyer"))?.id).toBe(a.id);
		expect(await openConversation(db, sale, "seller", 1)).toMatchObject({
			ok: false,
			error: { code: "own_sale" },
		});
	});

	it("[MSG-one-conversation] only the two parties can read it or write in it", async () => {
		const c = await conversation();
		expect(await loadConversation(db, c.id, "other")).toBeUndefined();
		expect(await postMessage(db, memoryStore(), c, "other", text("hi"), 2)).toMatchObject({
			ok: false,
			error: { code: "not_participant" },
		});
		expect((await loadConversation(db, c.id, "buyer"))?.side).toBe("buyer");
		expect((await loadConversation(db, c.id, "seller"))?.side).toBe("seller");
	});

	it("lists conversations with messages in the inbox, unread for the side that hasn't read", async () => {
		const c = await conversation();
		expect(await inbox(db, "buyer")).toEqual([]);
		await postMessage(db, memoryStore(), c, "buyer", text("Can I see the back?"), 5);
		const [sellerView] = await inbox(db, "seller");
		expect(sellerView).toMatchObject({ id: c.id, side: "seller", otherName: "User buyer", unread: true });
		expect((await inbox(db, "buyer"))[0]?.unread).toBe(false);
		await markRead(db, (await loadConversation(db, c.id, "seller"))!, 6);
		expect((await inbox(db, "seller"))[0]?.unread).toBe(false);
		expect(await inbox(db, "other")).toEqual([]);
	});

	it("returns messages after a time, oldest first, marked mine for the viewer", async () => {
		const c = await conversation();
		await postMessage(db, memoryStore(), c, "buyer", text("one"), 5);
		await postMessage(db, memoryStore(), c, "seller", text("two"), 7);
		expect((await messagesOf(db, c, "seller", 0)).map((m) => [m.body, m.mine])).toEqual([
			["one", false],
			["two", true],
		]);
		expect((await messagesOf(db, c, "seller", 5)).map((m) => m.body)).toEqual(["two"]);
	});
});

describe("posting", () => {
	it("validates the text", async () => {
		const c = await conversation();
		expect(await postMessage(db, memoryStore(), c, "buyer", text("   "), 2)).toMatchObject({
			ok: false,
			error: { code: "empty" },
		});
	});

	it("[MSG-payment-warning] flags a message that asks for an off-platform payment", async () => {
		const c = await conversation();
		const flagged = await postMessage(
			db,
			memoryStore(),
			c,
			"seller",
			text("pay me F&F on PayPal instead"),
			2,
		);
		expect(flagged).toMatchObject({ ok: true, value: { paymentWarning: true } });
		const plain = await postMessage(db, memoryStore(), c, "buyer", text("Is it near mint?"), 3);
		expect(plain).toMatchObject({ ok: true, value: { paymentWarning: false } });
		expect((await messagesOf(db, c, "buyer", 0)).map((m) => m.paymentWarning)).toEqual([true, false]);
	});

	it("stores photos in R2 without metadata and rejects files that aren't photos", async () => {
		const store = memoryStore();
		const c = await conversation();
		const posted = await postMessage(
			db,
			store,
			c,
			"buyer",
			{ body: "", images: [jpegBytes(800, 600, { exif: true })] },
			2,
		);
		expect(posted.ok).toBe(true);
		const [object] = [...store.objects];
		expect(object![0]).toMatch(new RegExp(`^messages/${c.id}/.+\\.jpg$`));
		expect(new TextDecoder().decode(object![1].body)).not.toContain(GPS_MARKER);
		const [message] = await messagesOf(db, c, "seller", 0);
		expect(message?.attachments).toEqual([
			{
				id: expect.any(String),
				url: expect.stringMatching(/^\/api\/messages\/attachments\//),
				width: 800,
				height: 600,
			},
		]);
		expect(
			await postMessage(
				db,
				store,
				c,
				"buyer",
				{ body: "x", images: [new TextEncoder().encode("not a photo")] },
				3,
			),
		).toMatchObject({ ok: false, error: { code: "unsupported_type" } });
	});

	it("[MSG-attachment-access] a message photo is served only to the two parties and admins", async () => {
		const c = await conversation();
		await postMessage(db, memoryStore(), c, "buyer", { body: "", images: [jpegBytes(10, 10)] }, 2);
		const attachment = (await db.select().from(messageAttachments).get())!;
		expect(await findAttachmentFor(db, attachment.id, { id: "buyer", admin: false })).toMatchObject({
			contentType: "image/jpeg",
		});
		expect(await findAttachmentFor(db, attachment.id, { id: "seller", admin: false })).toBeDefined();
		expect(await findAttachmentFor(db, attachment.id, { id: "other", admin: true })).toBeDefined();
		expect(await findAttachmentFor(db, attachment.id, { id: "other", admin: false })).toBeUndefined();
		expect(await findAttachmentFor(db, attachment.id, null)).toBeUndefined();
		expect(await findAttachmentFor(db, "missing", { id: "buyer", admin: false })).toBeUndefined();
	});

	it("reads the composer form, skipping an empty file input", async () => {
		const data = new FormData();
		data.set("body", "hello");
		data.append("photos", new File([], ""));
		data.append(
			"photos",
			new File([jpegBytes(4, 4) as Uint8Array<ArrayBuffer>], "a.jpg", { type: "image/jpeg" }),
		);
		const form = await readMessageForm(data);
		expect(form.body).toBe("hello");
		expect(form.images).toHaveLength(1);
		expect((await readMessageForm(new FormData())).body).toBe("");
	});
});

describe("blocks and reports", () => {
	it("[MSG-block] the seller blocks a buyer, who then can't write; unblocking lets them again", async () => {
		const c = await conversation();
		const sellerView = (await loadConversation(db, c.id, "seller"))!;
		const buyerView = (await loadConversation(db, c.id, "buyer"))!;
		expect(await blockBuyer(db, buyerView, "buyer", 1)).toMatchObject({ ok: false });
		expect(await blockBuyer(db, sellerView, "seller", 1)).toEqual({ ok: true, value: true });
		expect(await isBlocked(db, "seller", "buyer")).toBe(true);
		expect((await loadConversation(db, c.id, "buyer"))?.blocked).toBe(true);
		expect(await postMessage(db, memoryStore(), c, "buyer", text("hello?"), 2)).toMatchObject({
			ok: false,
			error: { code: "blocked" },
		});
		expect((await postMessage(db, memoryStore(), c, "seller", text("Sorry, no."), 3)).ok).toBe(true);
		expect(await unblockBuyer(db, buyerView, "buyer")).toMatchObject({ ok: false });
		expect(await unblockBuyer(db, sellerView, "seller")).toEqual({ ok: true, value: true });
		expect((await postMessage(db, memoryStore(), c, "buyer", text("thanks"), 4)).ok).toBe(true);
	});

	it("[MSG-report] a participant reports the other side's message once; it reaches the admin queue", async () => {
		const c = await conversation();
		await postMessage(db, memoryStore(), c, "seller", text("pay me with gift cards"), 2);
		const buyerView = (await loadConversation(db, c.id, "buyer"))!;
		const messageId = buyerView.messages[0]!.id;
		const input = { messageId, reason: "off_platform_payment", details: "  asked for gift cards  " };
		expect(await reportMessage(db, buyerView, "buyer", { ...input, reason: "nonsense" }, 3)).toMatchObject({
			ok: false,
			error: { code: "invalid_reason" },
		});
		expect(await reportMessage(db, buyerView, "buyer", input, 3)).toEqual({ ok: true, value: true });
		expect(await reportMessage(db, buyerView, "buyer", input, 4)).toMatchObject({
			ok: false,
			error: { code: "already_reported" },
		});
		// Your own message can't be reported.
		const sellerView = (await loadConversation(db, c.id, "seller"))!;
		expect(await reportMessage(db, sellerView, "seller", input, 5)).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		const [queued] = await openReports(db);
		expect(queued).toMatchObject({
			reason: "off_platform_payment",
			details: "asked for gift cards",
			reporterHandle: "buyer",
			reportedHandle: "seller",
			messageBody: "pay me with gift cards",
		});
		expect(await closeReport(db, queued!.id, "admin", "resolved", 9)).toBe(true);
		expect(await closeReport(db, queued!.id, "admin", "dismissed", 9)).toBe(false);
		expect(await openReports(db)).toEqual([]);
		expect((await db.select().from(reports).get())?.status).toBe("resolved");
		// Once closed, the same message can be reported again.
		expect((await reportMessage(db, buyerView, "buyer", input, 10)).ok).toBe(true);
	});
});
