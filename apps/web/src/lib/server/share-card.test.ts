import { createDb, eq, type Db } from "@claimsale/db";
import { items, saleAccess, sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { listItems } from "./items.ts";
import { findSaleBySlug } from "./sales.ts";
import {
	cachedShareImage,
	loadShareCard,
	SHARE_IMAGE_DESIGN,
	shareImageKey,
	shareMeta,
	type ShareImageBucket,
} from "./share-card.ts";

let db: Db;

async function addSale(id: string, over: Partial<typeof sales.$inferInsert> = {}) {
	await db.insert(sales).values({
		id,
		sellerId: "misty",
		slug: id,
		title: `Sale ${id}`,
		visibility: "unlisted",
		status: "live",
		createdAt: 1,
		updatedAt: 1,
		...over,
	});
	await db.insert(items).values({
		id: `${id}-item`,
		saleId: id,
		sortOrder: 1,
		gameId: "pokemon",
		title: "Secret Charizard",
		priceCents: 12_500,
		createdAt: 1,
		updatedAt: 1,
	});
}

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "misty", { handle: "misty" });
});

describe("loadShareCard", () => {
	it("shows a public or unlisted sale's items to everyone", async () => {
		await addSale("pub", { visibility: "public" });
		await addSale("unl");
		for (const slug of ["pub", "unl"]) {
			const loaded = await loadShareCard(db, slug);
			expect(loaded?.card.items).toEqual([{ title: "Secret Charizard", price: "$125.00", soldOut: false }]);
			expect(loaded?.card.seller).toBe("User misty (@misty)");
		}
	});

	it("[SHARE-private-title-only] a private sale's card has no items, even when it has an allowlist and password", async () => {
		await addSale("priv", { visibility: "private" });
		await db
			.insert(saleAccess)
			.values({ saleId: "priv", passwordHash: "x", allowlistEnabled: true, updatedAt: 1 });
		const loaded = await loadShareCard(db, "priv");
		expect(loaded?.card).toMatchObject({ title: "Sale priv", private: true, items: [], itemCount: 0 });
	});

	it("is null for drafts, deleted and missing sales", async () => {
		await addSale("draft", { status: "draft" });
		await addSale("gone", { status: "deleted" });
		expect(await loadShareCard(db, "draft")).toBeNull();
		expect(await loadShareCard(db, "gone")).toBeNull();
		expect(await loadShareCard(db, "nope")).toBeNull();
	});

	it("[SHARE-cache-version] gets a new version when an item on the card changes", async () => {
		await addSale("pub", { visibility: "public" });
		const before = await loadShareCard(db, "pub");
		await db.update(items).set({ priceCents: 9_900 }).where(eq(items.id, "pub-item"));
		const after = await loadShareCard(db, "pub");
		expect(after?.version).not.toBe(before?.version);
		expect(after?.version.startsWith(`${SHARE_IMAGE_DESIGN}-`)).toBe(true);
	});
});

describe("shareMeta", () => {
	it("[SHARE-private-title-only] describes a private sale by title and seller only", async () => {
		await addSale("priv", { visibility: "private", title: "Friends only" });
		const sale = (await findSaleBySlug(db, "priv"))!;
		// The seller's own view passes the items; the tags must still leave them out.
		const meta = shareMeta(sale, await listItems(db, "priv"), "https://claimsale.test");
		expect(meta).toEqual({
			title: "Friends only",
			description: "A private sale by User misty (@misty) on ClaimSale. Live now.",
			image: expect.stringMatching(/^https:\/\/claimsale\.test\/og\/s\/priv\.png\?v=\d+-[0-9a-z]+$/),
			url: "https://claimsale.test/s/priv",
		});
		expect(JSON.stringify(meta)).not.toContain("Charizard");
	});

	it("points at the same versioned image the image route serves", async () => {
		await addSale("unl");
		const sale = (await findSaleBySlug(db, "unl"))!;
		const meta = shareMeta(sale, await listItems(db, "unl"), "https://claimsale.test")!;
		const loaded = (await loadShareCard(db, "unl"))!;
		expect(meta.image).toBe(`https://claimsale.test/og/s/unl.png?v=${loaded.version}`);
		expect(meta.description).toBe("1 item from User misty (@misty). Live now. Claim on ClaimSale.");
	});

	it("is null for a draft the seller is looking at", async () => {
		await addSale("draft", { status: "draft" });
		const sale = (await findSaleBySlug(db, "draft"))!;
		expect(shareMeta(sale, [], "https://claimsale.test")).toBeNull();
	});
});

/** An in-memory stand-in for the parts of R2 the cache uses. */
function fakeBucket() {
	const store = new Map<string, ArrayBuffer>();
	const bucket = {
		get: async (key: string) => {
			const value = store.get(key);
			return value ? { body: value } : null;
		},
		put: async (key: string, value: ArrayBuffer) => {
			store.set(key, value);
		},
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
		}),
		delete: async (keys: string[]) => {
			for (const k of keys) store.delete(k);
		},
	};
	return { store, bucket: bucket as unknown as ShareImageBucket };
}

const png = (n: number) => new Uint8Array([n]).buffer;

describe("cachedShareImage", () => {
	it("[SHARE-cache-version] renders once per version and serves the cached copy after", async () => {
		const { store, bucket } = fakeBucket();
		const render = vi.fn<() => Promise<ArrayBuffer>>(async () => png(1));
		expect(await cachedShareImage(bucket, "s1", "3-abc", render)).toEqual({ body: png(1), cached: false });
		expect(await cachedShareImage(bucket, "s1", "3-abc", render)).toEqual({ body: png(1), cached: true });
		expect(render).toHaveBeenCalledTimes(1);
		expect([...store.keys()]).toEqual([shareImageKey("s1", "3-abc")]);
	});

	it("drops the sale's older versions, and only that sale's", async () => {
		const { store, bucket } = fakeBucket();
		await cachedShareImage(bucket, "s1", "3-old", async () => png(1));
		await cachedShareImage(bucket, "s10", "3-other", async () => png(2));
		await cachedShareImage(bucket, "s1", "3-new", async () => png(3));
		expect([...store.keys()].toSorted()).toEqual([
			shareImageKey("s1", "3-new"),
			shareImageKey("s10", "3-other"),
		]);
	});

	it("stores nothing when rendering fails", async () => {
		const { store, bucket } = fakeBucket();
		await expect(
			cachedShareImage(bucket, "s1", "3-x", async () => {
				throw new Error("emoji fetch failed");
			}),
		).rejects.toThrow("emoji fetch failed");
		expect(store.size).toBe(0);
	});
});
