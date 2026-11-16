import { ok, reject, type Millis, type Rejection, type Result } from "@claimsale/core";
import { and, asc, desc, eq, isNull, ne, type Db } from "@claimsale/db";
import { addresses } from "@claimsale/db/schema";
import { uuidv7 } from "uuidv7";

/**
 * The buyer's address book (PLAN §3 "Invoice", /me/addresses). A seller sees an
 * address only as the snapshot on that buyer's invoice. Deleting is soft, so an
 * invoice's snapshot never dangles. US only at launch (D7).
 */

export type AddressRow = typeof addresses.$inferSelect;

export interface AddressFields {
	readonly name: string;
	readonly line1: string;
	readonly line2: string | null;
	readonly city: string;
	readonly region: string;
	readonly postalCode: string;
	readonly country: "US";
}

export type AddressErrors = Partial<
	Record<"name" | "line1" | "line2" | "city" | "region" | "postalCode", string>
>;

/** US states, DC and territories with USPS codes. */
const US_REGIONS = new Set(
	"AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP AA AE AP".split(
		" ",
	),
);

export const MAX_ADDRESSES = 10;

const clean = (s: string) => s.trim().replace(/\s+/g, " ");

export function validateAddress(
	input: Record<keyof AddressErrors, string>,
): { ok: true; value: AddressFields } | { ok: false; errors: AddressErrors } {
	const errors: AddressErrors = {};
	const name = clean(input.name);
	const line1 = clean(input.line1);
	const line2 = clean(input.line2);
	const city = clean(input.city);
	const region = clean(input.region).toUpperCase();
	const postalCode = clean(input.postalCode);
	if (name.length === 0 || name.length > 100) errors.name = "Enter the recipient's name";
	if (line1.length === 0 || line1.length > 100) errors.line1 = "Enter the street address";
	if (line2.length > 100) errors.line2 = "Use at most 100 characters";
	if (city.length === 0 || city.length > 60) errors.city = "Enter the city";
	if (!US_REGIONS.has(region)) errors.region = "Enter a two-letter state code, e.g. CA";
	if (!/^\d{5}(-\d{4})?$/.test(postalCode)) errors.postalCode = "Enter a ZIP code like 94107 or 94107-1234";
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, value: { name, line1, line2: line2 || null, city, region, postalCode, country: "US" } };
}

export async function listAddresses(db: Db, userId: string): Promise<AddressRow[]> {
	return db
		.select()
		.from(addresses)
		.where(and(eq(addresses.userId, userId), isNull(addresses.deletedAt)))
		.orderBy(desc(addresses.isDefault), asc(addresses.createdAt))
		.all();
}

export async function addAddress(
	db: Db,
	userId: string,
	fields: AddressFields,
	makeDefault: boolean,
	now: Millis,
): Promise<Result<AddressRow, Rejection<"too_many">>> {
	const existing = await listAddresses(db, userId);
	if (existing.length >= MAX_ADDRESSES)
		return reject("too_many", `You can save up to ${MAX_ADDRESSES} addresses`);
	const isDefault = makeDefault || existing.length === 0;
	const id = uuidv7();
	const insert = db
		.insert(addresses)
		.values({ id, userId, ...fields, isDefault, createdAt: now, updatedAt: now })
		.returning();
	if (isDefault) {
		const [, rows] = await db.batch([
			db.update(addresses).set({ isDefault: false, updatedAt: now }).where(eq(addresses.userId, userId)),
			insert,
		]);
		return ok(rows[0]!);
	}
	const [row] = await insert;
	return ok(row!);
}

export async function setDefaultAddress(
	db: Db,
	userId: string,
	addressId: string,
	now: Millis,
): Promise<Result<true, Rejection<"not_found">>> {
	const found = (await listAddresses(db, userId)).some((a) => a.id === addressId);
	if (!found) return reject("not_found", "No such address");
	await db.batch([
		db
			.update(addresses)
			.set({ isDefault: false, updatedAt: now })
			.where(and(eq(addresses.userId, userId), ne(addresses.id, addressId))),
		db.update(addresses).set({ isDefault: true, updatedAt: now }).where(eq(addresses.id, addressId)),
	]);
	return ok(true);
}

/** Soft-deletes; if it was the default, the oldest remaining address becomes the default. */
export async function deleteAddress(
	db: Db,
	userId: string,
	addressId: string,
	now: Millis,
): Promise<Result<true, Rejection<"not_found">>> {
	const list = await listAddresses(db, userId);
	const target = list.find((a) => a.id === addressId);
	if (!target) return reject("not_found", "No such address");
	await db
		.update(addresses)
		.set({ deletedAt: now, isDefault: false, updatedAt: now })
		.where(eq(addresses.id, addressId));
	const next = list.find((a) => a.id !== addressId);
	if (target.isDefault && next) await setDefaultAddress(db, userId, next.id, now);
	return ok(true);
}
