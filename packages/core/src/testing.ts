/**
 * Test factories for the domain core (TESTING §8). Not exported from the package
 * entry point; tests import this file directly.
 */
import { DAY, HOUR, type Actor, type Millis, type Result, type Tier } from "./common.ts";
import { newInvoice, type Invoice, type ShippingOption } from "./invoice.ts";
import type { Buyer, Entry, Item, ItemContext } from "./item.ts";
import type { Sale } from "./sale.ts";

export const T0: Millis = Date.UTC(2026, 10, 1, 12);
export const SELLER = "seller_1";

export const seller = (tier: Tier = "free"): Actor => ({ kind: "seller", id: SELLER, tier });
export const buyerActor = (id: string, tier: Tier = "free"): Actor => ({ kind: "buyer", id, tier });
export const admin: Actor = { kind: "admin", id: "admin_1" };
export const system: Actor = { kind: "system" };

export function makeBuyer(id: string, overrides: Partial<Buyer> = {}): Buyer {
	return {
		id,
		tier: "free",
		blocked: false,
		emailVerified: true,
		accountCreatedAt: T0 - 365 * DAY,
		...overrides,
	};
}

export function makeItem(overrides: Partial<Item> = {}): Item {
	return {
		id: "item_1",
		priceCents: 4000,
		quantity: 1,
		perBuyerLimit: 1,
		offersEnabled: true,
		minOfferCents: null,
		decisionDeadline: null,
		offersLapseAt: null,
		withdrawn: false,
		entries: [],
		...overrides,
	};
}

export function makeEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "buyerId">): Entry {
	return {
		kind: "claim",
		amountCents: 4000,
		status: "open",
		createdAt: T0,
		rankOverride: null,
		counterCents: null,
		counterExpiresAt: null,
		wonAt: null,
		endedAt: null,
		endedReason: null,
		endedBy: null,
		...overrides,
	};
}

export function makeContext(overrides: Partial<ItemContext> = {}): ItemContext {
	return {
		saleStatus: "live",
		sellerId: SELLER,
		sellerTier: "free",
		reviewEveryClaim: false,
		allowBackupOffers: true,
		decisionWindow: 24 * HOUR,
		buyerRequirements: { emailVerified: true, minAccountAge: 0 },
		...overrides,
	};
}

export function makeSale(overrides: Partial<Sale> = {}): Sale {
	return { status: "draft", liveAt: null, closesAt: null, sellerTier: "free", itemCount: 3, ...overrides };
}

export function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
	return { ...newInvoice("inv_1", "buyer_1", SELLER, "free"), ...overrides };
}

export const SHIPPING_MENU: readonly ShippingOption[] = [
	{ id: "pwe", label: "Stamped envelope", priceCents: 100, tracked: false },
	{ id: "ground", label: "Ground Advantage", priceCents: 550, tracked: true },
];

/** Unwraps an ok result, failing the test with the rejection otherwise. */
export function expectOk<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
	return result.value;
}

/** Unwraps a rejection's code, failing the test if the result was ok. */
export function expectRejected<T, E extends { code: string }>(result: Result<T, E>): string {
	if (result.ok) throw new Error("expected a rejection, got ok");
	return result.error.code;
}
