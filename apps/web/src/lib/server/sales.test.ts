import { createDb, eq, type Db } from "@claimsale/db";
import { saleAllowlist, sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { DEFAULT_TERMS, readTerms, type SaleDetails } from "#lib/listing-input.ts";
import {
	countActiveSales,
	createDraft,
	deleteDraft,
	findSaleBySlug,
	findSellerSale,
	isAllowlisted,
	listSellerSales,
	newSlug,
	readAllowlist,
	setPrivateAccess,
	updateDetails,
	updateTerms,
	type Seller,
} from "./sales.ts";

let db: Db;
const free: Seller = { id: "seller", tier: "free" };
const pro: Seller = { id: "pro", tier: "pro" };
const details: SaleDetails = {
	title: "Weekend YGO dump",
	descriptionMd: "LOB singles",
	visibility: "unlisted",
};

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	await addUser(db, "pro");
	await addUser(db, "buyer", { email: "Buyer@Example.test" });
});

async function draft(seller = free, over: Partial<typeof details> = {}) {
	const result = await createDraft(db, seller, { ...details, ...over }, 1000);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

describe("sales repository", () => {
	it("makes readable, unique slugs", () => {
		expect(newSlug("Weekend YGO dump!", () => "abc123")).toBe("weekend-ygo-dump-abc123");
		expect(newSlug("Pokémon — Japanese promos", () => "x")).toBe("pokemon-japanese-promos-x");
		expect(newSlug("!!!", () => "x")).toBe("sale-x");
		expect(newSlug("a".repeat(100), () => "x")).toBe(`${"a".repeat(40)}-x`);
		expect(newSlug("t")).toMatch(/^t-[a-z2-9]{8}$/);
		expect(newSlug("t")).not.toBe(newSlug("t"));
	});

	it("creates a draft with default terms and lists it for its seller only", async () => {
		const sale = await draft();
		expect(sale).toMatchObject({
			status: "draft",
			sellerId: "seller",
			visibility: "unlisted",
			currency: "USD",
		});
		expect(readTerms(sale.terms)).toEqual(DEFAULT_TERMS);
		expect(await listSellerSales(db, "seller")).toEqual([
			expect.objectContaining({ id: sale.id, title: details.title, itemCount: 0 }),
		]);
		expect(await listSellerSales(db, "pro")).toEqual([]);
		expect(await findSellerSale(db, "pro", sale.id)).toBeUndefined();
	});

	it("[SM-2-private-pro] refuses a private sale for a free seller, and allows it for Pro", async () => {
		const refused = await createDraft(db, free, { ...details, visibility: "private" }, 1);
		expect(refused).toMatchObject({ ok: false, error: { code: "pro_only" } });
		expect(await draft(pro, { visibility: "private" })).toMatchObject({ visibility: "private" });

		const sale = await draft();
		const switched = await updateDetails(db, free, sale.id, { ...details, visibility: "private" }, 2);
		expect(switched).toMatchObject({ ok: false, error: { code: "pro_only" } });
	});

	it("updates details and terms while the sale is editable", async () => {
		const sale = await draft();
		const updated = await updateDetails(db, free, sale.id, { ...details, title: "New title" }, 2000);
		expect(updated).toMatchObject({ ok: true, value: { title: "New title", updatedAt: 2000 } });
		const terms = { ...DEFAULT_TERMS, rulesMd: "No holds", paymentMethods: ["venmo"] };
		const saved = await updateTerms(db, free, sale.id, terms, 3000);
		expect(saved.ok && readTerms(saved.value.terms)).toEqual(terms);
		expect(saved.ok && saved.value.termsMd).toBe("No holds");
		expect(await updateDetails(db, pro, sale.id, details, 1)).toMatchObject({ error: { code: "not_found" } });

		await db.update(sales).set({ status: "closed" }).where(eq(sales.id, sale.id));
		expect(await updateTerms(db, free, sale.id, terms, 4000)).toMatchObject({
			error: { code: "invalid_status" },
		});
	});

	it("[SM-2-free-sale-cap] counts only the seller's scheduled and live sales", async () => {
		const a = await draft();
		const b = await draft();
		const c = await draft();
		expect(await countActiveSales(db, "seller")).toBe(0);
		await db.update(sales).set({ status: "scheduled" }).where(eq(sales.id, a.id));
		await db.update(sales).set({ status: "live" }).where(eq(sales.id, b.id));
		await db.update(sales).set({ status: "closed" }).where(eq(sales.id, c.id));
		expect(await countActiveSales(db, "seller")).toBe(2);
		expect(await countActiveSales(db, "seller", a.id)).toBe(1);
		expect(await countActiveSales(db, "pro")).toBe(0);
	});

	it("deletes only drafts, and a deleted sale disappears from the seller's list", async () => {
		const sale = await draft();
		expect(await deleteDraft(db, "seller", sale.id, 5)).toEqual({ ok: true, value: true });
		expect(await listSellerSales(db, "seller")).toEqual([]);
		expect(await deleteDraft(db, "seller", sale.id, 6)).toMatchObject({ error: { code: "not_found" } });
		const live = await draft();
		await db.update(sales).set({ status: "live" }).where(eq(sales.id, live.id));
		expect(await deleteDraft(db, "seller", live.id, 7)).toMatchObject({ error: { code: "invalid_status" } });
	});

	it("[SM-2-visibility] a private sale needs a password or an invite list, and only verified emails count", async () => {
		const sale = await draft(pro, { visibility: "private" });
		expect(await setPrivateAccess(db, sale.id, { passwordHash: null, allowlist: [] }, 1)).toMatchObject({
			error: { code: "access_required" },
		});
		expect(
			await setPrivateAccess(db, sale.id, { allowlist: ["buyer@example.test", "BUYER@example.test"] }, 2),
		).toEqual({
			ok: true,
			value: { revoked: false },
		});
		expect(await readAllowlist(db, sale.id)).toEqual(["buyer@example.test"]);
		const found = await findSaleBySlug(db, sale.slug);
		expect(found).toMatchObject({ allowlistEnabled: true, hasPassword: false, sellerHandle: "pro" });
		expect(await isAllowlisted(db, sale.id, { email: "Buyer@Example.test", emailVerified: true })).toBe(true);
		expect(await isAllowlisted(db, sale.id, { email: "buyer@example.test", emailVerified: false })).toBe(
			false,
		);
		expect(await isAllowlisted(db, sale.id, { email: "other@example.test", emailVerified: true })).toBe(
			false,
		);
		expect(await isAllowlisted(db, sale.id, null)).toBe(false);

		// Keeping the password (undefined) while turning the list off.
		await setPrivateAccess(
			db,
			sale.id,
			{ passwordHash: "pbkdf2$1$a$b", allowlist: ["buyer@example.test"] },
			3,
		);
		await setPrivateAccess(db, sale.id, { allowlist: null }, 4);
		expect(await findSaleBySlug(db, sale.slug)).toMatchObject({ hasPassword: true, allowlistEnabled: false });
		expect(await readAllowlist(db, sale.id)).toEqual([]);
		expect(await findSaleBySlug(db, "nope")).toBeUndefined();
	});

	it("[LIVE-access] says when someone may have lost access to a private sale", async () => {
		const sale = await draft(pro, { visibility: "private" });
		const save = async (update: Parameters<typeof setPrivateAccess>[2]) => {
			const saved = await setPrivateAccess(db, sale.id, update, 1);
			return saved.ok ? saved.value.revoked : saved.error.code;
		};
		// Setting up access for the first time, adding addresses and resaving revoke nothing.
		expect(await save({ passwordHash: "pbkdf2$1$a$b", allowlist: ["a@example.test"] })).toBe(false);
		expect(await save({ allowlist: ["a@example.test", "b@example.test"] })).toBe(false);
		expect(await save({ allowlist: ["b@example.test", "a@example.test"] })).toBe(false);
		// Taking an address off, changing or removing the password, or turning the list off do.
		expect(await save({ allowlist: ["a@example.test"] })).toBe(true);
		expect(await save({ passwordHash: "pbkdf2$1$c$d", allowlist: ["a@example.test"] })).toBe(true);
		expect(await save({ passwordHash: null, allowlist: ["a@example.test"] })).toBe(true);
		expect(await save({ passwordHash: "pbkdf2$1$e$f", allowlist: ["a@example.test"] })).toBe(false);
		expect(await save({ allowlist: null })).toBe(true);
	});

	it("[NOTIF-allowlist-invite] saving the invite list keeps who was already invited", async () => {
		const sale = await draft(pro, { visibility: "private" });
		await setPrivateAccess(db, sale.id, { allowlist: ["a@example.test", "b@example.test"] }, 1);
		// The engine marks invites it sent.
		await db.update(saleAllowlist).set({ invitedAt: 5 }).where(eq(saleAllowlist.email, "a@example.test"));
		await setPrivateAccess(db, sale.id, { allowlist: ["a@example.test", "c@example.test"] }, 6);
		const rows = await db
			.select({ email: saleAllowlist.email, invitedAt: saleAllowlist.invitedAt })
			.from(saleAllowlist)
			.where(eq(saleAllowlist.saleId, sale.id))
			.orderBy(saleAllowlist.email)
			.all();
		expect(rows).toEqual([
			{ email: "a@example.test", invitedAt: 5 },
			{ email: "c@example.test", invitedAt: null },
		]);
	});
});
