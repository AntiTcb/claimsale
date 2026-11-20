import type { Tier } from "@claimsale/core";
import { error, redirect, type RequestEvent } from "@sveltejs/kit";
import { validateSaleDetails, type SaleDetails } from "#lib/listing-input.ts";
import type { SessionUser } from "./auth.ts";
import { db } from "./context.ts";
import { entitlements } from "./entitlements.ts";
import { field } from "./forms.ts";
import { assertSellerReady } from "./seller.ts";
import { hashSalePassword, SALE_PASSWORD_MAX, SALE_PASSWORD_MIN } from "./sale-access.ts";
import { findSellerSale, type PrivateAccessUpdate, type SaleRow, type Seller } from "./sales.ts";

/** Shared pieces of the /sell pages: who is selling, their sale, and the details form. */

export function requireUser(event: Pick<RequestEvent, "locals" | "url">): SessionUser {
	const user = event.locals.user;
	if (!user) redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	return user;
}

/**
 * The signed-in seller with their tier, read server-side on every request (PLAN §3a).
 * Every /sell load and action calls this, so it is also the D55 gate (D70): accounts
 * missing 18+ or a verified email go to /sell/requirements instead.
 */
export async function requireSeller(
	event: Pick<RequestEvent, "locals" | "url">,
): Promise<Seller & { tier: Tier }> {
	const user = requireUser(event);
	const { seller } = await entitlements(db(), user.id, Date.now());
	assertSellerReady(event.url, user);
	return { id: user.id, tier: seller };
}

/** The seller's own sale, or a 404 (the same for someone else's sale). */
export async function requireOwnSale(sellerId: string, saleId: string): Promise<SaleRow> {
	const sale = await findSellerSale(db(), sellerId, saleId);
	if (!sale) error(404, "No such sale");
	return sale;
}

export type DetailsErrors = Partial<
	Record<"title" | "description" | "visibility" | "password" | "allowlist" | "form", string>
>;

export interface DetailsValues {
	title: string;
	description: string;
	visibility: string;
	allowlist: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads the details form: title, description, visibility, and for private sales
 * the password and invite list (D5).
 */
export async function readDetailsForm(
	data: FormData,
	options: { hasPassword: boolean },
): Promise<
	| { ok: true; details: SaleDetails; access: PrivateAccessUpdate | null; values: DetailsValues }
	| { ok: false; errors: DetailsErrors; values: DetailsValues }
> {
	const values: DetailsValues = {
		title: field(data, "title"),
		description: field(data, "description"),
		visibility: field(data, "visibility"),
		allowlist: field(data, "allowlist"),
	};
	const errors: DetailsErrors = {};
	const details = validateSaleDetails(values);
	if (!details.ok) Object.assign(errors, "errors" in details ? details.errors : {});
	let access: PrivateAccessUpdate | null = null;
	if (values.visibility === "private") {
		const password = field(data, "password");
		const emails = values.allowlist
			.split(/[\s,;]+/)
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean);
		const bad = emails.find((e) => !EMAIL.test(e));
		if (bad) errors.allowlist = `"${bad.slice(0, 60)}" isn't an email address`;
		else if (emails.length > 500) errors.allowlist = "Invite at most 500 emails";
		if (password && (password.length < SALE_PASSWORD_MIN || password.length > SALE_PASSWORD_MAX)) {
			errors.password = `Use ${SALE_PASSWORD_MIN}–${SALE_PASSWORD_MAX} characters`;
		}
		if (!password && !options.hasPassword && emails.length === 0 && !errors.allowlist) {
			errors.password = "Set a password, invite at least one email, or both";
		}
		access = {
			...(password ? { passwordHash: await hashSalePassword(password) } : {}),
			allowlist: emails.length > 0 ? emails : null,
		};
	}
	if (!details.ok || Object.keys(errors).length > 0) return { ok: false, errors, values };
	return { ok: true, details: details.value, access, values };
}
