import {
	DAY,
	decisionWindow,
	DEFAULT_BUYER_REQUIREMENTS,
	HOUR,
	paymentDeadline,
	shippingMenuFrom,
	type BuyerRequirements,
	type Millis,
	type ShippingOption,
	type Tier,
} from "@claimsale/core";

/**
 * The sale settings the engine's rules read, from `sales.terms` (JSON written by the
 * web Worker's terms form, `SaleTerms` in apps/web/src/lib/listing-input.ts) and
 * `sales.shipping`. Unknown or missing fields fall back to the defaults, so terms
 * written before a setting existed keep working.
 *
 * Fields read from `terms`:
 * - `reviewEveryClaim` (D34, default false), `allowBackupOffers` (D43, default true)
 * - `paymentDeadlineHours` 24 | 48 (D13; 24 only counts for Pro sellers)
 * - `decisionWindowHours` (D25; Pro only, any positive number)
 * - `autoSendAtClose` (D49, default false), `autoRescindOverdue` (D13, default false)
 * - `requireVerifiedEmail` (D20, default true), `minAccountAgeDays` (D29, default 0)
 */
export interface SaleSettings {
	readonly reviewEveryClaim: boolean;
	readonly allowBackupOffers: boolean;
	readonly decisionWindow: Millis;
	readonly paymentDeadline: Millis;
	readonly autoSendAtClose: boolean;
	readonly autoRescindOverdue: boolean;
	readonly buyerRequirements: BuyerRequirements;
	readonly shippingMenu: readonly ShippingOption[];
}

const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};

const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** Parses JSON text (as D1 returns it) or an already-parsed value. */
export function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

/** The shipping menu (D15): entries that aren't well-formed are dropped. */
export function readShippingMenu(raw: unknown): ShippingOption[] {
	return shippingMenuFrom(parseJson(raw));
}

export function readSaleSettings(terms: unknown, shipping: unknown, sellerTier: Tier): SaleSettings {
	const t = record(parseJson(terms));
	const windowHours = positive(t["decisionWindowHours"]);
	const minAgeDays = positive(t["minAccountAgeDays"]);
	return {
		reviewEveryClaim: t["reviewEveryClaim"] === true,
		allowBackupOffers: t["allowBackupOffers"] !== false,
		decisionWindow: decisionWindow(sellerTier, windowHours === undefined ? undefined : windowHours * HOUR),
		paymentDeadline: paymentDeadline(sellerTier, t["paymentDeadlineHours"] === 24),
		autoSendAtClose: t["autoSendAtClose"] === true,
		autoRescindOverdue: t["autoRescindOverdue"] === true,
		buyerRequirements: {
			emailVerified: t["requireVerifiedEmail"] === false ? false : DEFAULT_BUYER_REQUIREMENTS.emailVerified,
			minAccountAge: minAgeDays === undefined ? DEFAULT_BUYER_REQUIREMENTS.minAccountAge : minAgeDays * DAY,
		},
		shippingMenu: readShippingMenu(shipping),
	};
}
