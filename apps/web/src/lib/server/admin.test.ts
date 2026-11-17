import { createDb, eq, type Db } from "@claimsale/db";
import { accountFlags, imageHashes } from "@claimsale/db/photos";
import { itemImages, users } from "@claimsale/db/schema";
import { isHttpError, isRedirect } from "@sveltejs/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, jpegBytes, memoryStore } from "../../../test/fixtures.ts";
import { heldPhotos, isAdmin, openFlags, requireAdmin, resolveFlag } from "./admin.ts";
import type { SessionUser } from "./auth.ts";
import { addItemPhoto, setTimestampPhoto } from "./images.ts";
import { addItem } from "./items.ts";
import { createDraft } from "./sales.ts";

const url = new URL("https://claimsale.test/admin");
const user = (role: string) => ({ id: "u", role }) as unknown as SessionUser;

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (e) {
		return e;
	}
	return undefined;
}

describe("admin guard", () => {
	it("[IMG-dup-review] only accounts with the admin role open /admin", () => {
		expect(isAdmin(user("admin"))).toBe(true);
		expect(isAdmin(user("user"))).toBe(false);
		expect(isAdmin(null)).toBe(false);
		expect(requireAdmin({ locals: { user: user("admin"), session: null }, url })).toMatchObject({ id: "u" });

		const signedOut = thrown(() => requireAdmin({ locals: { user: null, session: null }, url }));
		expect(isRedirect(signedOut) && signedOut.location).toBe("/login?next=%2Fadmin");
		const notAdmin = thrown(() => requireAdmin({ locals: { user: user("user"), session: null }, url }));
		expect(isHttpError(notAdmin) && notAdmin.status).toBe(404);
	});
});

describe("admin queues", () => {
	let db: Db;
	const store = memoryStore();

	beforeEach(async () => {
		db = createDb(testD1());
		await addUser(db, "seller", { handle: "ash" });
		await addUser(db, "admin");
	});

	async function heldItemPhoto() {
		const seller = { id: "seller", tier: "pro" as const };
		const sale = await createDraft(
			db,
			seller,
			{ title: "Sale", descriptionMd: "", visibility: "unlisted" },
			1,
		);
		if (!sale.ok) throw new Error("setup");
		const item = await addItem(
			db,
			seller,
			sale.value.id,
			{
				title: "Charizard",
				priceCents: 100,
				quantity: 1,
				gameId: "pokemon",
				kind: "single",
				condition: null,
				attributes: {},
			},
			1,
		);
		if (!item.ok) throw new Error("setup");
		const photo = await addItemPhoto(
			db,
			store,
			seller,
			{ saleId: sale.value.id, itemId: item.value.id },
			jpegBytes(10, 10),
			5,
		);
		const timestamp = await setTimestampPhoto(db, store, "seller", sale.value.id, jpegBytes(10, 10), 6);
		if (!photo.ok || !timestamp.ok) throw new Error("setup");
		await db
			.update(itemImages)
			.set({ status: "review", matchImageId: "their-photo", matchDistance: 9 })
			.where(eq(itemImages.saleId, sale.value.id));
		return { saleId: sale.value.id, imageId: photo.value.id, timestampId: timestamp.value.id };
	}

	it("[IMG-dup-review] lists held photos oldest first, with the match for the admin", async () => {
		const { saleId, imageId, timestampId } = await heldItemPhoto();
		expect(await heldPhotos(db)).toEqual([
			{
				imageId,
				saleId,
				saleTitle: "Sale",
				itemTitle: "Charizard",
				sellerHandle: "ash",
				matchImageId: "their-photo",
				matchDistance: 9,
				createdAt: 5,
			},
			expect.objectContaining({ imageId: timestampId, itemTitle: null }),
		]);
	});

	it("[IMG-repeat-offender] lists open flags with the seller's rejected total, and resolves them once", async () => {
		await db.insert(accountFlags).values({
			id: "flag-1",
			userId: "seller",
			reason: "repeat_photo_rejections",
			count: 3,
			createdAt: 10,
		});
		const hash = { dhash: "0000000000000000", phash: "0000000000000000" };
		const bands = { d0: 0, d1: 0, d2: 0, d3: 0, p0: 0, p1: 0, p2: 0, p3: 0 };
		for (const [i, reason] of (
			["duplicate", "possible_duplicate", "own_reuse", "duplicate"] as const
		).entries()) {
			await db.insert(imageHashes).values({
				imageId: `h${i}`,
				sellerId: "seller",
				saleId: "s",
				itemId: null,
				...hash,
				...bands,
				decision: "rejected",
				reason,
				createdAt: 1,
				decidedAt: 1,
				decidedBy: "system",
			});
		}
		expect(await openFlags(db)).toEqual([
			{
				flagId: "flag-1",
				userId: "seller",
				handle: "ash",
				displayName: "User seller",
				count: 3,
				rejectedTotal: 3,
				createdAt: 10,
			},
		]);
		expect(await resolveFlag(db, "flag-1", "admin", 20)).toBe(true);
		expect(await resolveFlag(db, "flag-1", "admin", 21)).toBe(false);
		expect(await openFlags(db)).toEqual([]);
		const flag = await db.select().from(accountFlags).where(eq(accountFlags.id, "flag-1")).get();
		expect(flag).toMatchObject({ resolvedAt: 20, resolvedBy: "admin" });
	});

	it("new accounts get the user role", async () => {
		const row = await db.select({ role: users.role }).from(users).where(eq(users.id, "seller")).get();
		expect(row).toEqual({ role: "user" });
	});
});
