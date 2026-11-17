/**
 * Photo authenticity in the engine (WS-F2): the verify job against real D1, R2 and the
 * WASM decoders in workerd, the band lookup, admin review, the queue consumer and the
 * image_hashes migration.
 */
import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { type Decoder } from "@claimsale/imagehash/decode";
import { hashImage, hashToHex, toBands } from "@claimsale/imagehash";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyEdit } from "../../../packages/imagehash/src/testing/synthetic.ts";
import { handleQueue } from "../src/handlers.ts";
import { Mailer } from "../src/mailer.ts";
import { requeueStalePhotos, STALE_PENDING_AFTER, verifyPhoto, workerDecoder } from "../src/photos/index.ts";
import { bandKeysJson, LOOKUP_SQL } from "../src/photos/store.ts";

const photo = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const cardA = photo(env.TEST_PHOTOS.cardA);
const cardAWebp = photo(env.TEST_PHOTOS.cardAWebp);
const cardB = photo(env.TEST_PHOTOS.cardB);

const db = env.DB;
let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

async function seller(): Promise<string> {
	const userId = id("u");
	await db
		.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, 'S', 1, 1)")
		.bind(userId, `${userId}@example.test`)
		.run();
	return userId;
}

async function sale(sellerId: string): Promise<string> {
	const saleId = id("sale");
	await db
		.prepare(
			"INSERT INTO sales (id, seller_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, 'Sale', 1, 1)",
		)
		.bind(saleId, sellerId, saleId)
		.run();
	return saleId;
}

async function item(saleId: string): Promise<string> {
	const itemId = id("item");
	await db
		.prepare(
			"INSERT INTO items (id, sale_id, sort_order, game_id, title, price_cents, created_at, updated_at) VALUES (?, ?, 0, 'pokemon', 'Card', 500, 1, 1)",
		)
		.bind(itemId, saleId)
		.run();
	return itemId;
}

/** Stores an upload the way the web Worker does: R2 object plus a `pending` row. */
async function upload(
	place: { sellerId: string; saleId: string; itemId: string | null },
	bytes: Uint8Array,
	createdAt = Date.now(),
): Promise<string> {
	const imageId = id("img");
	const key = `sales/${place.saleId}/${imageId}.jpg`;
	await env.IMAGES.put(key, bytes);
	await db
		.prepare(
			"INSERT INTO item_images (id, sale_id, item_id, seller_id, r2_key, content_type, bytes, status, created_at) VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, 'pending', ?)",
		)
		.bind(imageId, place.saleId, place.itemId, place.sellerId, key, bytes.byteLength, createdAt)
		.run();
	return imageId;
}

/** A seller with one sale and one item. */
async function newSeller() {
	const sellerId = await seller();
	const saleId = await sale(sellerId);
	const itemId = await item(saleId);
	return { sellerId, saleId, itemId };
}

const deps = (decode: Decoder = workerDecoder()) => ({ db, images: env.IMAGES, decode });
const verify = (imageId: string, decode?: Decoder) => Effect.runPromise(verifyPhoto(deps(decode), imageId));

const status = async (imageId: string) =>
	db
		.prepare("SELECT status, match_image_id, match_distance, verified_at FROM item_images WHERE id = ?")
		.bind(imageId)
		.first<{
			status: string;
			match_image_id: string | null;
			match_distance: number | null;
			verified_at: number;
		}>();

const hashRow = (imageId: string) =>
	db.prepare("SELECT * FROM image_hashes WHERE image_id = ?").bind(imageId).first();

/** Uploads and verifies; returns the image ID. */
async function verified(
	place: { sellerId: string; saleId: string; itemId: string | null },
	bytes: Uint8Array,
) {
	const imageId = await upload(place, bytes);
	await verify(imageId);
	return imageId;
}

/** A decoder that mirrors or rotates the decoded image (a re-uploader's edit). */
const edited =
	(edit: "mirror" | "r90"): Decoder =>
	async (bytes) =>
		applyEdit(await workerDecoder()(bytes), edit);

/**
 * Stores another seller's approved image 9 bits from `bytes` on both hashes (all in the
 * low bands, so band 0 still finds it): inside the review band. Returns its image ID.
 */
async function storeNearMatch(bytes: Uint8Array): Promise<string> {
	const hashes = hashImage(await workerDecoder()(bytes));
	const other = await seller();
	const storedId = id("stored");
	const dh = hashes.orig.dhash ^ 0x1ffn;
	const ph = hashes.orig.phash ^ 0x1ffn;
	await db
		.prepare(
			`INSERT INTO image_hashes (image_id, seller_id, sale_id, item_id, dhash, phash, d0, d1, d2, d3, p0, p1, p2, p3,
				decision, created_at, decided_at, decided_by)
			VALUES (?, ?, 'old-sale', 'old-item', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, 1, 'system')`,
		)
		.bind(storedId, other, hashToHex(dh), hashToHex(ph), ...toBands(dh), ...toBands(ph))
		.run();
	return storedId;
}

/** A photo held for review: uploaded next to another seller's near match. */
async function heldPhoto() {
	await storeNearMatch(cardB);
	const me = await newSeller();
	const imageId = await verified(me, cardB);
	expect((await status(imageId))?.status).toBe("review");
	return { me, imageId };
}

beforeEach(async () => {
	// Matches are global; start every test from an empty index.
	await db.batch([db.prepare("DELETE FROM image_hashes"), db.prepare("DELETE FROM account_flags")]);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("photo verify job", () => {
	it("[IMG-dup-reject] approves a new photo and indexes its orig hashes as hex and bands", async () => {
		const a = await newSeller();
		const imageId = await upload(a, cardA);
		const outcome = await verify(imageId);
		expect(outcome).toMatchObject({ kind: "decided", verdict: { decision: "approved", reason: null } });
		expect(await status(imageId)).toMatchObject({ status: "approved", match_image_id: null });

		const hashes = hashImage(await workerDecoder()(cardA));
		const row = await hashRow(imageId);
		expect(row).toMatchObject({
			seller_id: a.sellerId,
			sale_id: a.saleId,
			item_id: a.itemId,
			dhash: hashToHex(hashes.orig.dhash),
			phash: hashToHex(hashes.orig.phash),
			decision: "approved",
			decided_by: "system",
		});
		const [d0, d1, d2, d3] = toBands(hashes.orig.dhash);
		const [p0, p1, p2, p3] = toBands(hashes.orig.phash);
		expect(row).toMatchObject({ d0, d1, d2, d3, p0, p1, p2, p3 });
		const audit = await db
			.prepare("SELECT actor_id, action, data FROM audit_log WHERE json_extract(data, '$.imageId') = ?")
			.bind(imageId)
			.first<{ actor_id: string; action: string; data: string }>();
		expect(audit).toMatchObject({ actor_id: "system", action: "photo_verified" });
		expect(JSON.parse(audit!.data)).toMatchObject({ decision: "approved" });
	});

	it("[IMG-dup-reject] rejects another seller's copy, re-encoded or mirrored, recording the match for admins only", async () => {
		const a = await newSeller();
		const original = await verified(a, cardA);

		const b = await newSeller();
		const sameBytes = await verified(b, cardA);
		const reencoded = await verified({ ...b, itemId: await item(b.saleId) }, cardAWebp);
		const mirrored = await upload({ ...b, itemId: await item(b.saleId) }, cardA);
		await verify(mirrored, edited("mirror"));
		const rotated = await upload({ ...b, itemId: await item(b.saleId) }, cardA);
		await verify(rotated, edited("r90"));

		for (const imageId of [sameBytes, reencoded, mirrored, rotated]) {
			const row = await status(imageId);
			expect(row?.status).toBe("rejected");
			expect(row?.match_image_id).toBe(original);
			expect(row?.match_distance).toBeLessThanOrEqual(6);
			expect((await hashRow(imageId))?.["reason"]).toBe("duplicate");
		}
	});

	it("[IMG-dup-reject] another seller's deleted photo still counts (past or present)", async () => {
		const a = await newSeller();
		const original = await verified(a, cardA);
		await db.prepare("DELETE FROM item_images WHERE id = ?").bind(original).run();
		const b = await newSeller();
		expect((await status(await verified(b, cardA)))?.status).toBe("rejected");
	});

	it("[IMG-dup-reject] a different photo is approved", async () => {
		await verified(await newSeller(), cardA);
		const b = await newSeller();
		expect((await status(await verified(b, cardB)))?.status).toBe("approved");
	});

	it("[IMG-dup-review] holds a photo 7–12 bits from another seller's image for admin review", async () => {
		const storedId = await storeNearMatch(cardB);

		const me = await newSeller();
		const imageId = await verified(me, cardB);
		expect(await status(imageId)).toMatchObject({
			status: "review",
			match_image_id: storedId,
			match_distance: 9,
		});
		expect(await hashRow(imageId)).toMatchObject({ decision: "review", reason: "possible_duplicate" });
	});

	it("[IMG-own-reuse] your photo on a different item of the same sale is rejected; same item or a relist is fine", async () => {
		const me = await newSeller();
		await verified(me, cardA);
		const sameItem = await verified(me, cardA);
		expect((await status(sameItem))?.status).toBe("approved");

		const otherItem = await verified({ ...me, itemId: await item(me.saleId) }, cardA);
		expect((await status(otherItem))?.status).toBe("rejected");
		expect((await hashRow(otherItem))?.["reason"]).toBe("own_reuse");

		const relist = await verified({ ...me, saleId: await sale(me.sellerId), itemId: null }, cardB);
		expect((await status(relist))?.status).toBe("approved");
		const nextSale = await sale(me.sellerId);
		const relisted = await verified({ ...me, saleId: nextSale, itemId: await item(nextSale) }, cardA);
		expect((await status(relisted))?.status).toBe("approved");
	});

	it("[IMG-timestamp-required] an old timestamp photo can't be reused in a new sale, even your own", async () => {
		const me = await newSeller();
		const first = await verified({ ...me, itemId: null }, cardB);
		expect((await status(first))?.status).toBe("approved");
		const again = await verified({ ...me, saleId: await sale(me.sellerId), itemId: null }, cardB);
		expect((await status(again))?.status).toBe("rejected");
		expect((await hashRow(again))?.["reason"]).toBe("timestamp_reuse");
	});

	it("[IMG-repeat-offender] flags the account once after several rejected matches", async () => {
		await verified(await newSeller(), cardA);
		const thief = await newSeller();
		const flags = () =>
			db
				.prepare("SELECT reason, count, resolved_at FROM account_flags WHERE user_id = ?")
				.bind(thief.sellerId)
				.all();
		for (let i = 0; i < 2; i++) {
			// oxlint-disable-next-line no-await-in-loop
			await verified({ ...thief, itemId: await item(thief.saleId) }, cardA);
		}
		expect((await flags()).results).toEqual([]);
		const third = await upload({ ...thief, itemId: await item(thief.saleId) }, cardA);
		expect(await verify(third)).toMatchObject({ kind: "decided", flagged: true });
		await verified({ ...thief, itemId: await item(thief.saleId) }, cardA);
		expect((await flags()).results).toEqual([
			{ reason: "repeat_photo_rejections", count: 3, resolved_at: null },
		]);
	});

	it("[IMG-dup-reject] rejects a photo that can't be decoded", async () => {
		const me = await newSeller();
		const imageId = await upload(me, new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]));
		expect(await verify(imageId)).toEqual({ kind: "unreadable" });
		expect((await status(imageId))?.status).toBe("rejected");
		expect(await hashRow(imageId)).toBeNull();
	});

	it("[IMG-dup-reject] is idempotent: a decided or deleted photo is skipped", async () => {
		const me = await newSeller();
		const imageId = await verified(me, cardA);
		expect(await verify(imageId)).toEqual({ kind: "skipped", why: "already_decided" });
		expect(await verify("no-such-image")).toEqual({ kind: "skipped", why: "missing" });
	});

	it("[IMG-dup-reject] the band lookup uses the band indexes, with the keys in one parameter", async () => {
		const hashes = hashImage(await workerDecoder()(cardA));
		const { candidateBands } = await import("@claimsale/imagehash");
		const keys = bandKeysJson(candidateBands(hashes, 1));
		expect(Object.values(JSON.parse(keys) as Record<string, number[]>).flat().length).toBeGreaterThan(100);
		const { results } = await db
			.prepare(`EXPLAIN QUERY PLAN ${LOOKUP_SQL}`)
			.bind(keys, "x")
			.all<{ detail: string }>();
		const plan = results.map((r) => r.detail).join("\n");
		for (const column of ["d0", "d1", "d2", "d3", "p0", "p1", "p2", "p3"]) {
			expect(plan).toContain(`image_hashes_${column}`);
		}
		expect(plan).not.toMatch(/SCAN h\b/);
	});
});

describe("admin review (RPC)", () => {
	it("[IMG-dup-review] approving a held photo indexes it, so a later copy is rejected", async () => {
		const { imageId } = await heldPhoto();
		const admin = await seller();
		const result = await exports.default.reviewPhoto({ imageId, adminId: admin, decision: "approved" });
		expect(result).toEqual({ ok: true, value: true });
		expect((await status(imageId))?.status).toBe("approved");
		expect(await hashRow(imageId)).toMatchObject({ decision: "approved", decided_by: admin });
		// A second decision changes nothing.
		expect(await exports.default.reviewPhoto({ imageId, adminId: admin, decision: "rejected" })).toEqual({
			ok: true,
			value: false,
		});
		const copy = await verified(await newSeller(), cardB);
		expect(await status(copy)).toMatchObject({ status: "rejected", match_image_id: imageId });
	});

	it("[IMG-repeat-offender] rejecting held photos counts toward the flag", async () => {
		const admin = await seller();
		const { me, imageId } = await heldPhoto();
		await exports.default.reviewPhoto({ imageId, adminId: admin, decision: "rejected" });
		expect((await status(imageId))?.status).toBe("rejected");
		for (let i = 0; i < 2; i++) {
			const next = await upload({ ...me, itemId: await item(me.saleId) }, cardB);
			// oxlint-disable-next-line no-await-in-loop
			await verify(next);
			// oxlint-disable-next-line no-await-in-loop
			await exports.default.reviewPhoto({ imageId: next, adminId: admin, decision: "rejected" });
		}
		const flag = await db
			.prepare("SELECT count FROM account_flags WHERE user_id = ? AND resolved_at IS NULL")
			.bind(me.sellerId)
			.first<{ count: number }>();
		expect(flag).toEqual({ count: 3 });
	});

	it("[IMG-dup-review] refuses malformed input", async () => {
		const result = await exports.default.reviewPhoto({ imageId: "", adminId: "a", decision: "approved" });
		expect(result.ok).toBe(false);
	});
});

describe("photo queue messages", () => {
	const noMail = Layer.succeed(Mailer, { send: () => Effect.die(new Error("no mail in photo tests")) });

	async function consume(bodies: unknown[], withPhotos = true) {
		const batch = createMessageBatch(
			"claimsale-notifications-local",
			bodies.map((body, i) => ({ id: `p${i}`, timestamp: new Date(), attempts: 1, body })),
		);
		const ctx = createExecutionContext();
		await Effect.runPromise(
			handleQueue(batch, { probeRecipient: undefined, ...(withPhotos ? { photos: deps() } : {}) }).pipe(
				Effect.provide(noMail),
			),
		);
		return getQueueResult(batch, ctx);
	}

	it("[IMG-dup-reject] a photo_verify message is verified and acknowledged", async () => {
		const imageId = await upload(await newSeller(), cardA);
		const result = await consume([{ kind: "photo_verify", image_id: imageId }]);
		expect(result.explicitAcks).toEqual(["p0"]);
		expect((await status(imageId))?.status).toBe("approved");
	});

	it("[IMG-dup-reject] retries when the job can't reach its bindings", async () => {
		const imageId = await upload(await newSeller(), cardA);
		expect((await consume([{ kind: "photo_verify", image_id: imageId }], false)).retryMessages).toEqual([
			{ msgId: "p0" },
		]);
		const failing = { ...deps(), images: { get: () => Promise.reject(new Error("R2 down")) } };
		const batch = createMessageBatch("claimsale-notifications-local", [
			{ id: "r0", timestamp: new Date(), attempts: 1, body: { kind: "photo_verify", image_id: imageId } },
		]);
		const ctx = createExecutionContext();
		await Effect.runPromise(
			handleQueue(batch, { probeRecipient: undefined, photos: failing }).pipe(Effect.provide(noMail)),
		);
		expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([{ msgId: "r0" }]);
		expect((await status(imageId))?.status).toBe("pending");
	});

	it("[IMG-dup-reject] the web Worker's request is queued and the consumer decides it", async () => {
		const imageId = await upload(await newSeller(), cardA);
		expect(await exports.default.requestPhotoVerification({ imageId })).toEqual({ ok: true, value: true });
		await vi.waitFor(async () => expect((await status(imageId))?.status).toBe("approved"), {
			timeout: 15_000,
			interval: 200,
		});
	});

	it("[IMG-dup-reject] the cron re-queues photos left pending, within a day", async () => {
		const now = Date.now();
		const me = await newSeller();
		const stale = await upload(me, cardA, now - STALE_PENDING_AFTER - 1000);
		const fresh = await upload(me, cardB, now);
		const ancient = await upload(me, cardB, now - 2 * 24 * 60 * 60_000);
		const sent: unknown[] = [];
		const queue = {
			sendBatch: async (messages: unknown[]) => void sent.push(...messages),
		} as unknown as Queue;
		const count = await Effect.runPromise(requeueStalePhotos({ DB: db, NOTIFICATIONS: queue }));
		const ids = sent.map((m) => (m as { body: { image_id: string } }).body.image_id);
		expect(ids).toContain(stale);
		expect(ids).not.toContain(fresh);
		expect(ids).not.toContain(ancient);
		expect(count).toBe(ids.length);
	});
});

describe("image_hashes migration (expand/contract)", () => {
	it("0006 only adds tables, indexes and a defaulted column", () => {
		const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0006_"));
		const statements = migration!.queries.map((q) => q.replace(/^--.*$/gm, "").trim()).filter(Boolean);
		expect(statements.length).toBeGreaterThan(0);
		for (const statement of statements) {
			expect(statement).toMatch(
				/^(CREATE (UNIQUE )?(TABLE|INDEX) |ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL)/i,
			);
		}
	});

	it("applies on top of the previous schema, keeping its data; existing users get the user role", async () => {
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("migration-check-0006"));
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			for (const migration of env.TEST_MIGRATIONS.filter((m) => m.name < "0006_"))
				for (const query of migration.queries) sql.exec(query);
			sql.exec(
				"INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@example.test', 'A', 1, 1)",
			);
			for (const migration of env.TEST_MIGRATIONS.filter((m) => m.name >= "0006_"))
				for (const query of migration.queries) sql.exec(query);
			expect(sql.exec("SELECT id, role FROM users").toArray()).toEqual([{ id: "u1", role: "user" }]);
			const tables = sql
				.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map((r) => r["name"]);
			expect(tables).toEqual(expect.arrayContaining(["image_hashes", "account_flags"]));
		});
	});
});
