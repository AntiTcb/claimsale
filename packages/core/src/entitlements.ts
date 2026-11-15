import type { Actor, Tier, UserId } from "./common.ts";
import { FREE_ACTIVE_SALE_CAP, FREE_ITEM_CAP } from "./plans.ts";

/**
 * What an account's plan allows (PLAN §3a). Every tier check reads one of these,
 * so the source of the tier (a `plans`/`subscriptions` row, an admin grant) can
 * change without touching the rules.
 */
export interface Entitlements {
	readonly tier: Tier;
	/** D55: Pro sellers skip phone verification. */
	readonly sellerPhoneRequired: boolean;
	/** D29: Pro buyers skip email verification and sellers' new-account requirements. */
	readonly buyerRequirementsApply: boolean;
	/** D30; `null` for no cap. */
	readonly activeSaleCap: number | null;
	readonly itemCapPerSale: number | null;
}

const FREE: Entitlements = {
	tier: "free",
	sellerPhoneRequired: true,
	buyerRequirementsApply: true,
	activeSaleCap: FREE_ACTIVE_SALE_CAP,
	itemCapPerSale: FREE_ITEM_CAP,
};

const PRO: Entitlements = {
	tier: "pro",
	sellerPhoneRequired: false,
	buyerRequirementsApply: false,
	activeSaleCap: null,
	itemCapPerSale: null,
};

/** The plan for a tier; anything but `"pro"` is Free, so a missing or unknown plan never grants Pro. */
export function entitlementsFor(tier: unknown): Entitlements {
	return tier === "pro" ? PRO : FREE;
}

/** The actor a signed-in user acts as, with the tier from their entitlements (STATE_MACHINES §8). */
export function actorFor(kind: "buyer" | "seller", id: UserId, entitlements: Entitlements): Actor {
	return { kind, id, tier: entitlements.tier };
}
