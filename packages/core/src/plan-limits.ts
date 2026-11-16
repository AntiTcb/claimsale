import type { Actor, Tier, UserId } from "./common.ts";
import { FREE_ACTIVE_SALE_CAP, FREE_ITEM_CAP } from "./plans.ts";

/**
 * What a tier allows (PLAN §3a). The tier itself comes from `entitlements()` in
 * apps/web (`plans` / `subscriptions`); these are the rules that follow from it, so
 * the engine, the UI and tests agree.
 */
export interface PlanLimits {
	readonly tier: Tier;
	/** D55: Pro sellers skip phone verification. */
	readonly sellerPhoneRequired: boolean;
	/** D29: Pro buyers skip email verification and sellers' new-account requirements. */
	readonly buyerRequirementsApply: boolean;
	/** D30; `null` for no cap. */
	readonly activeSaleCap: number | null;
	readonly itemCapPerSale: number | null;
}

const FREE: PlanLimits = {
	tier: "free",
	sellerPhoneRequired: true,
	buyerRequirementsApply: true,
	activeSaleCap: FREE_ACTIVE_SALE_CAP,
	itemCapPerSale: FREE_ITEM_CAP,
};

const PRO: PlanLimits = {
	tier: "pro",
	sellerPhoneRequired: false,
	buyerRequirementsApply: false,
	activeSaleCap: null,
	itemCapPerSale: null,
};

/** The plan for a tier; anything but `"pro"` is Free, so a missing or unknown plan never grants Pro. */
export function planLimits(tier: unknown): PlanLimits {
	return tier === "pro" ? PRO : FREE;
}

/** The actor a signed-in user acts as, with the tier from their entitlements (STATE_MACHINES §8). */
export function actorFor(kind: "buyer" | "seller", id: UserId, limits: PlanLimits): Actor {
	return { kind, id, tier: limits.tier };
}
