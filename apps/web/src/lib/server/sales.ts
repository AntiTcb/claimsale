import {
	canUseVisibility,
	ok,
	reject,
	type Millis,
	type Rejection,
	type Result,
	type SaleStatus,
	type SaleVisibility,
	type Tier,
} from "@claimsale/core";
import { and, asc, desc, eq, inArray, ne, sql, type Db, type SQL } from "@claimsale/db";
import { items, saleAccess, saleAllowlist, sales, users } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";
import { DEFAULT_TERMS, type SaleDetails, type SaleTerms } from "#lib/listing-input.ts";

/** Sales repository: the seller's drafts, details, terms and private access. */

export type SaleRow = typeof sales.$inferSelect;

export interface Seller {
	readonly id: string;
	readonly tier: Tier;
}

export type SaleRejection = Rejection<"not_found" | "pro_only" | "invalid_status" | "access_required">;

const notFound = () => reject("not_found", "No such sale");

/** Statuses whose details the seller may still change. */
const EDITABLE: ReadonlySet<SaleStatus> = new Set(["draft", "scheduled", "live"]);

// ---------------------------------------------------------------------------
// Slugs

const SLUG_WORDS_MAX = 40;

/** "Weekend YGO dump!" → "weekend-ygo-dump-k3x9q2": readable, and unguessable enough for unlisted links. */
export function newSlug(title: string, random: () => string = randomSuffix): string {
	const base = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_WORDS_MAX)
		.replace(/-+$/g, "");
	return `${base || "sale"}-${random()}`;
}

function randomSuffix(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}

// ---------------------------------------------------------------------------
// Reads

export interface SellerSaleSummary {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly status: SaleStatus;
	readonly visibility: SaleVisibility;
	readonly liveAt: Millis | null;
	readonly itemCount: number;
	readonly updatedAt: Millis;
}

export async function listSellerSales(db: Db, sellerId: string): Promise<SellerSaleSummary[]> {
	return db
		.select({
			id: sales.id,
			slug: sales.slug,
			title: sales.title,
			status: sales.status,
			visibility: sales.visibility,
			liveAt: sales.liveAt,
			updatedAt: sales.updatedAt,
			itemCount: sql<number>`(SELECT count(*) FROM ${items} WHERE ${items.saleId} = ${sales.id})`,
		})
		.from(sales)
		.where(and(eq(sales.sellerId, sellerId), ne(sales.status, "deleted")))
		.orderBy(desc(sales.updatedAt))
		.all();
}

/** The seller's own sale, or undefined (also for someone else's sale: same answer). */
export async function findSellerSale(db: Db, sellerId: string, saleId: string): Promise<SaleRow | undefined> {
	return db
		.select()
		.from(sales)
		.where(and(eq(sales.id, saleId), eq(sales.sellerId, sellerId), ne(sales.status, "deleted")))
		.get();
}

export interface PublicSale extends SaleRow {
	readonly sellerHandle: string | null;
	readonly sellerDisplayName: string;
	readonly hasPassword: boolean;
	readonly allowlistEnabled: boolean;
	readonly passwordHash: string | null;
}

/** A sale by slug with its seller and access settings. Access is decided by the caller (saleAccess). */
export function findSaleBySlug(db: Db, slug: string): Promise<PublicSale | undefined> {
	return findPublicSale(db, eq(sales.slug, slug));
}

export function findSaleById(db: Db, saleId: string): Promise<PublicSale | undefined> {
	return findPublicSale(db, eq(sales.id, saleId));
}

async function findPublicSale(db: Db, where: SQL): Promise<PublicSale | undefined> {
	const row = await db
		.select({
			sale: sales,
			sellerHandle: users.handle,
			sellerDisplayName: users.displayName,
			passwordHash: saleAccess.passwordHash,
			allowlistEnabled: saleAccess.allowlistEnabled,
		})
		.from(sales)
		.innerJoin(users, eq(users.id, sales.sellerId))
		.leftJoin(saleAccess, eq(saleAccess.saleId, sales.id))
		.where(where)
		.get();
	if (!row) return undefined;
	return {
		...row.sale,
		sellerHandle: row.sellerHandle,
		sellerDisplayName: row.sellerDisplayName,
		passwordHash: row.passwordHash ?? null,
		hasPassword: !!row.passwordHash,
		allowlistEnabled: row.allowlistEnabled ?? false,
	};
}

/**
 * The seller's sales that count against the free cap, except `exceptSaleId`.
 *
 * @spec SM-2-free-sale-cap — counted from scheduled + live sales.
 */
export async function countActiveSales(db: Db, sellerId: string, exceptSaleId?: string): Promise<number> {
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(sales)
		.where(
			and(
				eq(sales.sellerId, sellerId),
				inArray(sales.status, ["scheduled", "live"]),
				exceptSaleId ? ne(sales.id, exceptSaleId) : undefined,
			),
		)
		.get();
	return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Writes

/**
 * Creates a draft with the seller's details and the default terms.
 *
 * @spec SM-2-private-pro — a free seller can't create a private sale.
 */
export async function createDraft(
	db: Db,
	seller: Seller,
	details: SaleDetails,
	now: Millis,
	slug: string = newSlug(details.title),
): Promise<Result<SaleRow, SaleRejection>> {
	const allowed = canUseVisibility(seller.tier, details.visibility);
	if (!allowed.ok) return allowed;
	const row = await db
		.insert(sales)
		.values({
			id: uuidv7(),
			sellerId: seller.id,
			slug,
			title: details.title,
			descriptionMd: details.descriptionMd,
			visibility: details.visibility,
			status: "draft",
			terms: { ...DEFAULT_TERMS },
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();
	return ok(row);
}

/**
 * @spec SM-2-private-pro — switching to private needs Pro.
 */
export async function updateDetails(
	db: Db,
	seller: Seller,
	saleId: string,
	details: SaleDetails,
	now: Millis,
): Promise<Result<SaleRow, SaleRejection>> {
	const sale = await findSellerSale(db, seller.id, saleId);
	if (!sale) return notFound();
	if (!EDITABLE.has(sale.status)) return reject("invalid_status", "This sale can no longer be edited");
	// A sale that is already private may stay private after a downgrade; it can't newly become private.
	if (sale.visibility !== "private") {
		const allowed = canUseVisibility(seller.tier, details.visibility);
		if (!allowed.ok) return allowed;
	}
	const row = await db
		.update(sales)
		.set({ ...details, updatedAt: now })
		.where(eq(sales.id, sale.id))
		.returning()
		.get();
	return ok(row);
}

export async function updateTerms(
	db: Db,
	seller: Seller,
	saleId: string,
	terms: SaleTerms,
	now: Millis,
): Promise<Result<SaleRow, SaleRejection>> {
	const sale = await findSellerSale(db, seller.id, saleId);
	if (!sale) return notFound();
	if (!EDITABLE.has(sale.status)) return reject("invalid_status", "This sale can no longer be edited");
	// Merged, so settings saved elsewhere (the shipping page's invoice switches) survive.
	const row = await db
		.update(sales)
		.set({ terms: { ...sale.terms, ...terms }, termsMd: terms.rulesMd, updatedAt: now })
		.where(eq(sales.id, sale.id))
		.returning()
		.get();
	return ok(row);
}

/** Deletes a draft (STATE_MACHINES §2: only drafts). Soft: the slug is never reused. */
export async function deleteDraft(
	db: Db,
	sellerId: string,
	saleId: string,
	now: Millis,
): Promise<Result<true, SaleRejection>> {
	const sale = await findSellerSale(db, sellerId, saleId);
	if (!sale) return notFound();
	if (sale.status !== "draft") return reject("invalid_status", "Only a draft can be deleted");
	await db.update(sales).set({ status: "deleted", updatedAt: now }).where(eq(sales.id, sale.id));
	return ok(true);
}

// ---------------------------------------------------------------------------
// Private access (D5)

export interface PrivateAccessUpdate {
	/** A new hash; null removes the password; undefined keeps the current one. */
	readonly passwordHash?: string | null;
	/** Lowercased emails; null turns the allowlist off. */
	readonly allowlist: readonly string[] | null;
}

/**
 * Sets the password and allowlist of a private sale.
 *
 * @spec SM-2-visibility — a private sale must have at least one way in.
 */
export async function setPrivateAccess(
	db: Db,
	saleId: string,
	update: PrivateAccessUpdate,
	now: Millis,
): Promise<Result<true, SaleRejection>> {
	const current = await db.select().from(saleAccess).where(eq(saleAccess.saleId, saleId)).get();
	const passwordHash =
		update.passwordHash === undefined ? (current?.passwordHash ?? null) : update.passwordHash;
	const allowlistEnabled = update.allowlist !== null && update.allowlist.length > 0;
	if (!passwordHash && !allowlistEnabled) {
		return reject("access_required", "Set a password or add at least one email to the invite list");
	}
	const emails = [...new Set((update.allowlist ?? []).map((e) => e.toLowerCase()))];
	await db.batch([
		db
			.insert(saleAccess)
			.values({ saleId, passwordHash, allowlistEnabled, updatedAt: now })
			.onConflictDoUpdate({
				target: saleAccess.saleId,
				set: { passwordHash, allowlistEnabled, updatedAt: now },
			}),
		db.delete(saleAllowlist).where(eq(saleAllowlist.saleId, saleId)),
		...emails.map((email) => db.insert(saleAllowlist).values({ saleId, email, createdAt: now })),
	]);
	return ok(true);
}

export async function readAllowlist(db: Db, saleId: string): Promise<string[]> {
	const rows = await db
		.select({ email: saleAllowlist.email })
		.from(saleAllowlist)
		.where(eq(saleAllowlist.saleId, saleId))
		.orderBy(asc(saleAllowlist.email))
		.all();
	return rows.map((r) => r.email);
}

/** Whether a *verified* email is on the sale's allowlist (D5). Unverified emails never count. */
export async function isAllowlisted(
	db: Db,
	saleId: string,
	viewer: { email: string; emailVerified: boolean } | null,
): Promise<boolean> {
	if (!viewer?.emailVerified) return false;
	const row = await db
		.select({ email: saleAllowlist.email })
		.from(saleAllowlist)
		.where(and(eq(saleAllowlist.saleId, saleId), eq(saleAllowlist.email, viewer.email.toLowerCase())))
		.get();
	return row !== undefined;
}
