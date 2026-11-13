import type { Actor } from "./common.ts";

/**
 * Who can do what (STATE_MACHINES §8). The engine checks this before running a
 * transition; the UI only uses it to hide buttons. Ownership (this seller's sale,
 * this buyer's entry) is checked by the transition functions themselves.
 */

export type Action =
	| "place_entry"
	| "withdraw_offer"
	| "leave_backup_queue"
	| "rescind_own_win"
	| "request_takeback"
	| "award"
	| "decline_offer"
	| "counter"
	| "configure_decision_window"
	| "set_hidden_min_offer"
	| "set_offer_visibility"
	| "choose_24h_payment_deadline"
	| "rescind_and_pass"
	| "reorder_backups";

const BUYER_ACTIONS: ReadonlySet<Action> = new Set([
	"place_entry",
	"withdraw_offer",
	"leave_backup_queue",
	"request_takeback",
]);
const SELLER_ACTIONS: ReadonlySet<Action> = new Set([
	"award",
	"decline_offer",
	"counter",
	"set_offer_visibility",
	"rescind_and_pass",
	"reorder_backups",
]);
const PRO_BUYER_ACTIONS: ReadonlySet<Action> = new Set(["rescind_own_win"]);
const PRO_SELLER_ACTIONS: ReadonlySet<Action> = new Set([
	"configure_decision_window",
	"set_hidden_min_offer",
	"choose_24h_payment_deadline",
]);

/**
 * Whether the actor may take the action at all.
 *
 * @spec SM-8-permissions — the section 8 matrix. Free buyers place entries once their
 * email is verified; that check is part of `place` (SM-4.1-buyer-requirements).
 */
export function can(actor: Actor, action: Action): boolean {
	switch (actor.kind) {
		case "buyer":
			return BUYER_ACTIONS.has(action) || (actor.tier === "pro" && PRO_BUYER_ACTIONS.has(action));
		case "seller":
			return SELLER_ACTIONS.has(action) || (actor.tier === "pro" && PRO_SELLER_ACTIONS.has(action));
		default:
			return false;
	}
}
