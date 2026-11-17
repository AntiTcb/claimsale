/**
 * The notifications consumer (WS-K) against real D1: sale events → notifications and
 * email, preferences, seller digests, followers, want lists, message nudges, invites and
 * the cron sweep. Email goes to an in-memory Mailer, except the end-to-end test, which
 * follows a real claim through the SaleEngine, the queue and the CapturingMailer.
 */
import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { handleQueue } from "../src/handlers.ts";
import { MailError, Mailer, mailerFor, type OutgoingMail } from "../src/mailer.ts";
import {
	deliver,
	handleSaleEvents,
	messagePosted,
	requestAllowlistInvites,
	sendDigest,
	sendInvites,
	sweepNotifications,
	type NotifyDeps,
	type SaleEventsMessage,
} from "../src/notifications/index.ts";
import { addUser, claim, db, makeSale, uid, value } from "./sale-fixtures.ts";

function fakeMailer(fail: (mail: OutgoingMail) => boolean = () => false) {
	const sent: OutgoingMail[] = [];
	const layer = Layer.succeed(Mailer, {
		send: (mail) =>
			fail(mail)
				? Effect.fail(new MailError({ cause: new Error("rate limited") }))
				: Effect.sync(() => {
						sent.push(mail);
						return { messageId: `m-${sent.length}` };
					}),
	});
	return { sent, layer };
}

function fakeQueue() {
	const sent: Array<{ body: unknown; delaySeconds: number | undefined }> = [];
	const response = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
	const queue = {
		send: async (body: unknown, options?: QueueSendOptions) => {
			sent.push({ body, delaySeconds: options?.delaySeconds });
			return response;
		},
		sendBatch: async (messages: Iterable<MessageSendRequest>) => {
			for (const m of messages) sent.push({ body: m.body, delaySeconds: m.delaySeconds });
			return response;
		},
	} as unknown as NotifyDeps["queue"];
	return { sent, queue };
}

function setup(mailer = fakeMailer()) {
	const q = fakeQueue();
	const deps: NotifyDeps = { db, queue: q.queue, siteUrl: "https://claimsale.test" };
	const run = <A, E>(program: Effect.Effect<A, E, Mailer>) =>
		Effect.runPromise(program.pipe(Effect.provide(mailer.layer)));
	return { deps, run, mail: mailer.sent, queued: q.sent };
}

const events = (saleId: string, list: unknown[]): SaleEventsMessage => ({
	kind: "sale_events",
	sale_id: saleId,
	events: list,
});

async function notificationsOf(userId: string) {
	const { results } = await db
		.prepare("SELECT * FROM notifications WHERE user_id = ?1 ORDER BY created_at, id")
		.bind(userId)
		.all<{
			id: string;
			type: string;
			payload: string;
			read_at: number | null;
			email_status: string;
			email_due_at: number | null;
			email_attempts: number;
			dedupe_key: string;
		}>();
	return results;
}

async function emailOf(userId: string) {
	return (await db.prepare("SELECT email FROM users WHERE id = ?1").bind(userId).first<{ email: string }>())!
		.email;
}

async function setVisibility(saleId: string, visibility: string) {
	await db.prepare("UPDATE sales SET visibility = ?1 WHERE id = ?2").bind(visibility, saleId).run();
}

/** A won entry row, as the engine writes it, so events can refer to it. */
async function addEntry(itemId: string, userId: string, kind: "claim" | "offer" = "claim") {
	const id = uid("entry");
	await db
		.prepare(
			"INSERT INTO entries (id, item_id, user_id, kind, amount_cents, status, created_at) VALUES (?1, ?2, ?3, ?4, 4000, 'won', 1)",
		)
		.bind(id, itemId, userId, kind)
		.run();
	return id;
}

describe("sale events → notifications", () => {
	it("[NOTIF-idempotent] a win notifies the buyer once and emails them, even when the batch is redelivered", async () => {
		const { deps, run, mail } = setup();
		const sale = await makeSale({ items: [{ title: "Blue-Eyes White Dragon" }] });
		const buyer = await addUser();
		const entryId = await addEntry(sale.itemIds[0]!, buyer);
		const body = events(sale.saleId, [
			{
				type: "entry_won",
				entryId,
				buyerId: buyer,
				amountCents: 4000,
				via: "instant",
				itemId: sale.itemIds[0],
			},
		]);
		await run(handleSaleEvents(deps, "msg-a", body));
		await run(handleSaleEvents(deps, "msg-a", body));
		const rows = await notificationsOf(buyer);
		expect(rows.map((r) => [r.type, r.email_status, r.dedupe_key])).toEqual([
			["claim_won", "sent", "se:msg-a:0"],
		]);
		expect(mail).toHaveLength(1);
		expect(mail[0]).toMatchObject({ to: await emailOf(buyer), subject: "You won “Blue-Eyes White Dragon”" });
		expect(mail[0]!.text).toContain(`https://claimsale.test/s/${sale.saleId}/i/${sale.itemIds[0]}`);
		expect(mail[0]!.html).toContain("Choose which emails you get");
	});

	it("[NOTIF-idempotent] a redelivered batch still sends an email an earlier attempt failed to send", async () => {
		let failing = true;
		const { deps, run, mail } = setup(fakeMailer(() => failing));
		const sale = await makeSale();
		const buyer = await addUser();
		const entryId = await addEntry(sale.itemIds[0]!, buyer);
		const body = events(sale.saleId, [
			{
				type: "entry_won",
				entryId,
				buyerId: buyer,
				amountCents: 4000,
				via: "award",
				itemId: sale.itemIds[0],
			},
		]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await run(handleSaleEvents(deps, "msg-b", body));
		warn.mockRestore();
		let [row] = await notificationsOf(buyer);
		expect(row).toMatchObject({ email_status: "pending", email_attempts: 1 });
		// The retry is due later; the cron sweep sends it then.
		await db.prepare("UPDATE notifications SET email_due_at = 0 WHERE id = ?1").bind(row!.id).run();
		failing = false;
		await run(sweepNotifications(deps));
		[row] = await notificationsOf(buyer);
		expect(row!.email_status).toBe("sent");
		expect(mail).toHaveLength(1);
	});

	it("[NOTIF-preferences] email respects the category switch and a verified address; the bell always gets it", async () => {
		const { deps, run, mail } = setup();
		const sale = await makeSale();
		const optedOut = await addUser();
		const unverified = await addUser(uid("u"), { emailVerified: false });
		await db
			.prepare("INSERT INTO notification_preferences (user_id, email_off, updated_at) VALUES (?1, ?2, 1)")
			.bind(optedOut, JSON.stringify(["purchases"]))
			.run();
		const a = await addEntry(sale.itemIds[0]!, optedOut);
		const b = await addEntry(sale.itemIds[0]!, unverified);
		await run(
			handleSaleEvents(
				deps,
				"msg-c",
				events(sale.saleId, [
					{
						type: "entry_won",
						entryId: a,
						buyerId: optedOut,
						amountCents: 1,
						via: "instant",
						itemId: sale.itemIds[0],
					},
					{
						type: "entry_won",
						entryId: b,
						buyerId: unverified,
						amountCents: 1,
						via: "instant",
						itemId: sale.itemIds[0],
					},
				]),
			),
		);
		expect((await notificationsOf(optedOut)).map((r) => r.email_status)).toEqual(["off"]);
		expect((await notificationsOf(unverified)).map((r) => r.email_status)).toEqual(["skipped"]);
		expect(mail).toEqual([]);
	});

	it("[NOTIF-seller-batch] a seller's claims become one digest email", async () => {
		const { deps, run, mail, queued } = setup();
		const sale = await makeSale({ items: [{ title: "Pikachu" }, { title: "Mew" }] });
		for (const [i, itemId] of [sale.itemIds[0]!, sale.itemIds[1]!, sale.itemIds[0]!].entries()) {
			const entryId = await addEntry(itemId, await addUser());
			await run(
				handleSaleEvents(
					deps,
					`msg-d${i}`,
					events(sale.saleId, [{ type: "entry_placed", entryId, status: "open", itemId }]),
				),
			);
		}
		const rows = await notificationsOf(sale.sellerId);
		expect(rows.map((r) => [r.type, r.email_status])).toEqual([
			["seller_new_claim", "batched"],
			["seller_new_claim", "batched"],
			["seller_new_claim", "batched"],
		]);
		// Only the first activity of the window schedules the digest.
		expect(queued).toEqual([{ body: { kind: "notify_digest", user_id: sale.sellerId }, delaySeconds: 300 }]);
		expect(mail).toEqual([]);

		expect(await run(sendDigest(deps, sale.sellerId))).toBe(true);
		expect(mail).toHaveLength(1);
		expect(mail[0]).toMatchObject({
			to: await emailOf(sale.sellerId),
			subject: "3 new claims in the last few minutes",
		});
		expect(mail[0]!.text).toContain("“Test sale”: 3 new claims");
		expect((await notificationsOf(sale.sellerId)).map((r) => r.email_status)).toEqual([
			"sent",
			"sent",
			"sent",
		]);
		// Nothing left: a second digest message sends nothing.
		expect(await run(sendDigest(deps, sale.sellerId))).toBe(false);
	});

	it("[NOTIF-seller-batch] activity the seller already read isn't emailed, and a lost digest is swept", async () => {
		const { deps, run, mail } = setup();
		const sale = await makeSale();
		const entryId = await addEntry(sale.itemIds[0]!, await addUser());
		await run(
			handleSaleEvents(
				deps,
				"msg-e",
				events(sale.saleId, [{ type: "entry_placed", entryId, status: "open", itemId: sale.itemIds[0] }]),
			),
		);
		await db
			.prepare("UPDATE notifications SET read_at = 1, email_due_at = 0 WHERE user_id = ?1")
			.bind(sale.sellerId)
			.run();
		await run(sweepNotifications(deps));
		expect(mail).toEqual([]);
		expect((await notificationsOf(sale.sellerId)).map((r) => r.email_status)).toEqual(["skipped"]);
	});
});

describe("followers and want lists", () => {
	it("[SM-2-go-live-alarm] going live tells each follower of a public sale once", async () => {
		const { deps, run, mail } = setup();
		const sale = await makeSale({ status: "live" });
		await setVisibility(sale.saleId, "public");
		const followers = [await addUser(), await addUser()];
		for (const f of followers)
			await db
				.prepare("INSERT INTO follows (follower_id, seller_id, created_at) VALUES (?1, ?2, 1)")
				.bind(f, sale.sellerId)
				.run();
		const body = events(sale.saleId, [{ type: "sale_live" }, { type: "followers_notified" }]);
		await run(handleSaleEvents(deps, "msg-f", body));
		await run(handleSaleEvents(deps, "msg-f-again", body));
		for (const f of followers) {
			expect((await notificationsOf(f)).map((r) => [r.type, r.email_status])).toEqual([
				["followed_sale_live", "sent"],
			]);
		}
		expect(mail.map((m) => m.subject)).toEqual(["“Test sale” is live", "“Test sale” is live"]);
	});

	it("[SM-2-go-live-alarm] an unlisted sale isn't announced to followers", async () => {
		const { deps, run } = setup();
		const sale = await makeSale({ status: "live" });
		const follower = await addUser();
		await db
			.prepare("INSERT INTO follows (follower_id, seller_id, created_at) VALUES (?1, ?2, 1)")
			.bind(follower, sale.sellerId)
			.run();
		await run(
			handleSaleEvents(
				deps,
				"msg-g",
				events(sale.saleId, [{ type: "sale_live" }, { type: "followers_notified" }]),
			),
		);
		expect(await notificationsOf(follower)).toEqual([]);
	});

	it("[TCG-want-list-notify] a public sale's matching listing notifies the want list's owner once", async () => {
		const { deps, run, mail } = setup();
		const productId = await addCatalogProduct();
		const sale = await makeSale({
			status: "scheduled",
			liveAt: Date.now() + 86_400_000,
			items: [{ priceCents: 2500 }, {}],
		});
		await setVisibility(sale.saleId, "public");
		await db
			.prepare("UPDATE items SET catalog_product_id = ?1, condition = 'NM', finish = 'holo' WHERE id = ?2")
			.bind(String(productId), sale.itemIds[0])
			.run();
		const collector = await addUser();
		const picky = await addUser();
		await addWant(collector, productId, { maxPriceCents: 3000 });
		await addWant(picky, productId, { maxPriceCents: 2000 });
		const body = events(sale.saleId, [{ type: "sale_scheduled", liveAt: 1 }, { type: "followers_notified" }]);
		await run(handleSaleEvents(deps, "msg-h", body));
		// Going live re-checks the sale; the owner isn't told twice.
		await run(
			handleSaleEvents(
				deps,
				"msg-h2",
				events(sale.saleId, [{ type: "sale_live" }, { type: "followers_notified" }]),
			),
		);
		expect((await notificationsOf(collector)).map((r) => r.type)).toEqual(["want_list_match"]);
		expect(await notificationsOf(picky)).toEqual([]);
		expect(mail.map((m) => m.subject)).toEqual(["Want list match: “Card 0”"]);
	});
});

let products = 0;
async function addCatalogProduct() {
	const n = Date.now() * 10 + products++;
	const set = await db
		.prepare(
			"INSERT INTO catalog_sets (game_id, code, name, tcgplayer_group_id, updated_at) VALUES ('pokemon', ?1, 'Test set', ?2, 1) RETURNING id",
		)
		.bind(`T${n}`, n)
		.first<{ id: number }>();
	const product = await db
		.prepare(
			"INSERT INTO catalog_products (game_id, set_id, kind, name, tcgplayer_product_id, updated_at) VALUES ('pokemon', ?1, 'single', 'Charizard', ?2, 1) RETURNING id",
		)
		.bind(set!.id, n)
		.first<{ id: number }>();
	return product!.id;
}

async function addWant(userId: string, productId: number, options: { maxPriceCents?: number } = {}) {
	await db
		.prepare(
			"INSERT INTO want_list_items (id, user_id, product_id, max_price_cents, created_at) VALUES (?1, ?2, ?3, ?4, 1)",
		)
		.bind(uid("want"), userId, productId, options.maxPriceCents ?? null)
		.run();
}

async function conversationWithMessage() {
	const sale = await makeSale();
	const buyer = await addUser();
	const conversationId = uid("conv");
	const messageId = uid("msg");
	await db
		.prepare(
			"INSERT INTO conversations (id, sale_id, buyer_id, seller_id, created_at) VALUES (?1, ?2, ?3, ?4, 1)",
		)
		.bind(conversationId, sale.saleId, buyer, sale.sellerId)
		.run();
	await db
		.prepare(
			"INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (?1, ?2, ?3, 'hi', 1)",
		)
		.bind(messageId, conversationId, buyer)
		.run();
	return { sale, buyer, conversationId, messageId };
}

async function privateSale(status: "draft" | "scheduled" | "live") {
	const sale = await makeSale({
		status,
		...(status === "scheduled" ? { liveAt: Date.now() + 86_400_000 } : {}),
	});
	await setVisibility(sale.saleId, "private");
	await db
		.prepare("INSERT INTO sale_access (sale_id, allowlist_enabled, updated_at) VALUES (?1, 1, 1)")
		.bind(sale.saleId)
		.run();
	for (const email of ["a@example.test", "b@example.test"])
		await db
			.prepare("INSERT INTO sale_allowlist (sale_id, email, created_at) VALUES (?1, ?2, 1)")
			.bind(sale.saleId, email)
			.run();
	return sale;
}

describe("messages", () => {
	it("[MSG-email-unread] a message notifies the other side now and emails only if still unread later", async () => {
		const { deps, run, mail, queued } = setup();
		const { sale, conversationId, messageId } = await conversationWithMessage();
		expect(await run(messagePosted(deps, { messageId }))).toBe(true);
		expect(await run(messagePosted(deps, { messageId }))).toBe(true);
		const [row] = await notificationsOf(sale.sellerId);
		expect(row).toMatchObject({ type: "new_message", email_status: "pending" });
		expect(JSON.parse(row!.payload)).toMatchObject({ conversationId });
		expect(row!.email_due_at! - Date.now()).toBeGreaterThan(9 * 60_000);
		expect(queued[0]).toEqual({ body: { kind: "notify_deliver", ids: [row!.id] }, delaySeconds: 600 });
		// Before it is due, the nudge sends nothing.
		await run(deliver(deps, [row!.id]));
		expect(mail).toEqual([]);
		await db.prepare("UPDATE notifications SET email_due_at = 0 WHERE id = ?1").bind(row!.id).run();
		await run(deliver(deps, [row!.id]));
		expect(mail.map((m) => m.subject)).toEqual([expect.stringMatching(/^New message from /)]);
		expect(mail[0]!.text).toContain(`/me/messages/${conversationId}`);
		// Message bodies never go into email.
		expect(mail[0]!.text).not.toContain("hi\n");
	});

	it("[MSG-email-unread] a message read before the delay is never emailed", async () => {
		const { deps, run, mail } = setup();
		const { sale, messageId } = await conversationWithMessage();
		await run(messagePosted(deps, { messageId }));
		await db
			.prepare("UPDATE notifications SET read_at = 5, email_due_at = 0 WHERE user_id = ?1")
			.bind(sale.sellerId)
			.run();
		await run(sweepNotifications(deps));
		expect(mail).toEqual([]);
		expect((await notificationsOf(sale.sellerId)).map((r) => r.email_status)).toEqual(["skipped"]);
	});

	it("ignores a message that doesn't exist", async () => {
		const { deps, run } = setup();
		expect(await run(messagePosted(deps, { messageId: "nope" }))).toBe(false);
	});
});

describe("allowlist invites", () => {
	it("[NOTIF-allowlist-invite] publishing a private sale invites each address once", async () => {
		const { deps, run, mail, queued } = setup();
		const sale = await privateSale("scheduled");
		await run(
			handleSaleEvents(
				deps,
				"msg-i",
				events(sale.saleId, [{ type: "sale_scheduled", liveAt: 1 }, { type: "followers_notified" }]),
			),
		);
		expect(queued).toEqual([
			{ body: { kind: "allowlist_invites", sale_id: sale.saleId }, delaySeconds: undefined },
		]);
		expect(await run(sendInvites(deps, sale.saleId))).toEqual({ sent: 2, failed: 0 });
		expect(mail.map((m) => m.to).toSorted()).toEqual(["a@example.test", "b@example.test"]);
		expect(mail[0]!.subject).toBe("You're invited to a private sale: Test sale");
		expect(mail[0]!.text).toContain(`https://claimsale.test/s/${sale.saleId}`);
		// Already invited: nothing more.
		expect(await run(sendInvites(deps, sale.saleId))).toEqual({ sent: 0, failed: 0 });
		// An address added later is invited when the seller saves the list.
		await db
			.prepare("INSERT INTO sale_allowlist (sale_id, email, created_at) VALUES (?1, 'c@example.test', 2)")
			.bind(sale.saleId)
			.run();
		expect(await run(requestAllowlistInvites(deps, { saleId: sale.saleId, sellerId: sale.sellerId }))).toBe(
			true,
		);
		expect(await run(sendInvites(deps, sale.saleId))).toEqual({ sent: 1, failed: 0 });
		expect(mail.map((m) => m.to)).toContain("c@example.test");
	});

	it("[NOTIF-allowlist-invite] a draft invites nobody; another seller can't trigger invites", async () => {
		const { deps, run, mail, queued } = setup();
		const sale = await privateSale("draft");
		expect(await run(sendInvites(deps, sale.saleId))).toEqual({ sent: 0, failed: 0 });
		expect(await run(requestAllowlistInvites(deps, { saleId: sale.saleId, sellerId: "someone-else" }))).toBe(
			false,
		);
		expect(mail).toEqual([]);
		expect(queued).toEqual([]);
	});

	it("[NOTIF-allowlist-invite] a failed invite is put back and the message retried", async () => {
		const { deps } = setup();
		const sale = await privateSale("live");
		const failing = fakeMailer((m) => m.to === "b@example.test");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const batch = createMessageBatch("claimsale-notifications-local", [
			{
				id: "inv-1",
				timestamp: new Date(),
				attempts: 1,
				body: { kind: "allowlist_invites", sale_id: sale.saleId },
			},
		]);
		const ctx = createExecutionContext();
		await Effect.runPromise(
			handleQueue(batch, { probeRecipient: undefined, notifications: deps }).pipe(
				Effect.provide(failing.layer),
			),
		);
		warn.mockRestore();
		expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([{ msgId: "inv-1" }]);
		expect(failing.sent.map((m) => m.to)).toEqual(["a@example.test"]);
		const pending = await db
			.prepare("SELECT email FROM sale_allowlist WHERE sale_id = ?1 AND invited_at IS NULL")
			.bind(sale.saleId)
			.all<{ email: string }>();
		expect(pending.results).toEqual([{ email: "b@example.test" }]);
	});
});

describe("queue routing and the mailers", () => {
	it("routes notification messages to the consumer and acks them", async () => {
		const { deps } = setup();
		const mailer = fakeMailer();
		const batch = createMessageBatch("claimsale-notifications-local", [
			{ id: "r1", timestamp: new Date(), attempts: 1, body: { kind: "notify_deliver", ids: [] } },
			{ id: "r2", timestamp: new Date(), attempts: 1, body: { kind: "notify_digest", user_id: "nobody" } },
		]);
		const ctx = createExecutionContext();
		await Effect.runPromise(
			handleQueue(batch, { probeRecipient: undefined, notifications: deps }).pipe(
				Effect.provide(mailer.layer),
			),
		);
		expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["r1", "r2"]);
	});

	it("`MAILER=capture` writes notification email to email_outbox", async () => {
		const to = `${uid("cap")}@Example.test`;
		await Effect.runPromise(
			Effect.gen(function* () {
				const mailer = yield* Mailer;
				return yield* mailer.send({ to, subject: "Captured", text: "t", html: "<p>h</p>" });
			}).pipe(Effect.provide(mailerFor({ ...env, MAILER: "capture" }))),
		);
		const row = await db
			.prepare("SELECT subject, html FROM email_outbox WHERE to_address = ?1")
			.bind(to.toLowerCase())
			.first();
		expect(row).toEqual({ subject: "Captured", html: "<p>h</p>" });
		// Anything else sends for real (fails closed): nothing is captured.
		const other = `${uid("cap")}@example.test`;
		await Effect.runPromise(
			Effect.gen(function* () {
				const mailer = yield* Mailer;
				return yield* mailer.send({ to: other, subject: "Sent", text: "t" });
			}).pipe(
				Effect.provide(mailerFor({ ...env, MAILER: "Capture" })),
				Effect.orElseSucceed(() => null),
			),
		);
		expect(
			await db.prepare("SELECT 1 FROM email_outbox WHERE to_address = ?1").bind(other).first(),
		).toBeNull();
	});

	it("[NOTIF-idempotent] end to end: a claim through the SaleEngine lands an email in the capture outbox", async () => {
		const sale = await makeSale({ items: [{ title: "End-to-end card", offers: "off" }] });
		const buyer = await addUser();
		value(await claim(sale, buyer));
		const address = await emailOf(buyer);
		await vi.waitFor(
			async () => {
				const row = await db
					.prepare("SELECT subject FROM email_outbox WHERE to_address = ?1")
					.bind(address)
					.first<{ subject: string }>();
				expect(row?.subject).toBe("You won “End-to-end card”");
			},
			{ timeout: 20_000, interval: 250 },
		);
		expect((await notificationsOf(buyer)).map((r) => r.type)).toEqual(["claim_won"]);
	}, 30_000);
});

describe("notifications migration (expand/contract)", () => {
	const MIGRATION = "0009_";

	it("only adds tables, indexes and nullable or defaulted notification columns", () => {
		const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith(MIGRATION));
		const statements = migration!.queries.map((q) => q.replace(/^--.*$/gm, "").trim()).filter(Boolean);
		expect(statements.length).toBeGreaterThan(0);
		for (const statement of statements) {
			expect(statement).toMatch(
				/^(CREATE (UNIQUE )?(TABLE|INDEX) |ALTER TABLE `notifications` ADD `\w+` (text|integer)( DEFAULT 0 NOT NULL)?;?$)/i,
			);
		}
	});

	it("applies on top of the previous schema, keeping existing notifications", async () => {
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("migration-check-0009"));
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			for (const migration of env.TEST_MIGRATIONS.filter((m) => m.name < MIGRATION))
				for (const query of migration.queries) sql.exec(query);
			sql.exec(
				"INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@example.test', 'A', 1, 1)",
			);
			sql.exec(
				"INSERT INTO notifications (id, user_id, type, created_at) VALUES ('n1', 'u1', 'claim_won', 1)",
			);
			for (const migration of env.TEST_MIGRATIONS.filter((m) => m.name >= MIGRATION))
				for (const query of migration.queries) sql.exec(query);
			expect(
				sql.exec("SELECT id, dedupe_key, email_status, email_attempts FROM notifications").toArray(),
			).toEqual([{ id: "n1", dedupe_key: null, email_status: null, email_attempts: 0 }]);
			const tables = sql
				.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map((r) => r["name"]);
			expect(tables).toEqual(
				expect.arrayContaining([
					"conversations",
					"messages",
					"message_attachments",
					"reports",
					"notification_preferences",
				]),
			);
		});
	});
});
