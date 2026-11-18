import {
	ok,
	reject,
	shippingMenuFrom,
	SUGGESTED_SHIPPING,
	validateShippingMenu,
	type Millis,
	type Rejection,
	type Result,
	type SaleStatus,
	type ShippingMenuError,
	type ShippingOption,
	type ShippingOptionInput,
} from "@claimsale/core";
import { eq, type Db } from "@claimsale/db";
import { sales, sellerProfiles } from "@claimsale/db/schema";
import { PAYMENT_METHODS } from "#lib/listing-input.ts";
import { paymentHandlesFrom, type PaymentHandle } from "./invoices.ts";
import { findSellerSale } from "./sales.ts";

/**
 * The /sell/[saleId]/shipping page (WS-J): the sale's shipping menu (D15, `sales.shipping`
 * as `[{ id, label, priceCents, tracked }]`), the two invoice switches the engine reads
 * from `sales.terms` (`autoSendAtClose`, D49; `autoRescindOverdue`, D13) and the seller's
 * payment handles (`seller_profiles.payment_handles`), which buyers see on invoices.
 */

export interface ShippingSettings {
	readonly menu: readonly ShippingOption[];
	readonly autoSendAtClose: boolean;
	readonly autoRescindOverdue: boolean;
	readonly paymentHandles: readonly PaymentHandle[];
}

/** Statuses whose shipping and invoice settings can still change (invoices go out after close). */
const EDITABLE: ReadonlySet<SaleStatus> = new Set(["draft", "scheduled", "live", "closed"]);

export const PAYMENT_HANDLE_MAX = 100;

export async function readShippingSettings(
	db: Db,
	sellerId: string,
	sale: { readonly shipping: unknown; readonly terms: Record<string, unknown> },
): Promise<ShippingSettings & { readonly suggested: boolean }> {
	const profile = await db
		.select({ paymentHandles: sellerProfiles.paymentHandles })
		.from(sellerProfiles)
		.where(eq(sellerProfiles.userId, sellerId))
		.get();
	const menu = shippingMenuFrom(sale.shipping);
	return {
		menu: menu.length > 0 ? menu : SUGGESTED_SHIPPING,
		suggested: menu.length === 0,
		autoSendAtClose: sale.terms["autoSendAtClose"] === true,
		autoRescindOverdue: sale.terms["autoRescindOverdue"] === true,
		paymentHandles: paymentHandlesFrom(profile?.paymentHandles),
	};
}

export interface ShippingSettingsInput {
	readonly options: readonly ShippingOptionInput[];
	readonly autoSendAtClose: boolean;
	readonly autoRescindOverdue: boolean;
	/** By payment method ID (PAYMENT_METHODS); blank removes the handle. */
	readonly handles: Readonly<Record<string, string>>;
}

export type ShippingSettingsErrors = {
	readonly menu: readonly ShippingMenuError[];
	readonly handles: Readonly<Record<string, string>>;
};

export function validateShippingSettings(
	input: ShippingSettingsInput,
	newId: () => string = () => crypto.randomUUID().slice(0, 8),
): Result<ShippingSettings, ShippingSettingsErrors> {
	const menu = validateShippingMenu(input.options, newId);
	const handles: PaymentHandle[] = [];
	const handleErrors: Record<string, string> = {};
	for (const method of PAYMENT_METHODS) {
		const value = (input.handles[method.id] ?? "").trim();
		if (value === "") continue;
		if (value.length > PAYMENT_HANDLE_MAX)
			handleErrors[method.id] = `Use at most ${PAYMENT_HANDLE_MAX} characters`;
		else handles.push({ kind: method.id, value });
	}
	if (!menu.ok || Object.keys(handleErrors).length > 0) {
		return { ok: false, error: { menu: menu.ok ? [] : menu.error, handles: handleErrors } };
	}
	return ok({
		menu: menu.value,
		autoSendAtClose: input.autoSendAtClose,
		autoRescindOverdue: input.autoRescindOverdue,
		paymentHandles: handles,
	});
}

/**
 * Saves the menu and the two switches on the sale, and the handles on the seller's
 * profile. Other `terms` fields are kept.
 *
 * @spec SM-6-shipping-menu
 */
export async function saveShippingSettings(
	db: Db,
	sellerId: string,
	saleId: string,
	settings: ShippingSettings,
	now: Millis,
): Promise<Result<true, Rejection<"not_found" | "invalid_status">>> {
	const sale = await findSellerSale(db, sellerId, saleId);
	if (!sale) return reject("not_found", "No such sale");
	if (!EDITABLE.has(sale.status))
		return reject("invalid_status", "This sale's settings can no longer change");
	const handles = settings.paymentHandles.map((h) => ({ kind: h.kind, value: h.value }));
	await db.batch([
		db
			.update(sales)
			.set({
				shipping: settings.menu.map((o) => ({
					id: o.id,
					label: o.label,
					priceCents: o.priceCents,
					tracked: o.tracked,
				})),
				terms: {
					...sale.terms,
					autoSendAtClose: settings.autoSendAtClose,
					autoRescindOverdue: settings.autoRescindOverdue,
				},
				updatedAt: now,
			})
			.where(eq(sales.id, sale.id)),
		db
			.insert(sellerProfiles)
			.values({ userId: sellerId, paymentHandles: handles, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: sellerProfiles.userId,
				set: { paymentHandles: handles, updatedAt: now },
			}),
	]);
	return ok(true);
}
