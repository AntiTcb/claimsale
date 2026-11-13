/**
 * Shared types for the domain core. Every transition is a pure function
 * `(state, command, actor, now) → Result<{ state, events }, Rejection>`
 * (STATE_MACHINES intro). Money is integer cents; time is server milliseconds.
 */

export type Millis = number;
export type UserId = string;

export const MINUTE: Millis = 60_000;
export const HOUR: Millis = 60 * MINUTE;
export const DAY: Millis = 24 * HOUR;

export type Tier = "free" | "pro";

/** Who performed a transition. `system` is a timer (DO alarm) or an automatic rule. */
export type Actor =
	| { readonly kind: "buyer"; readonly id: UserId; readonly tier: Tier }
	| { readonly kind: "seller"; readonly id: UserId; readonly tier: Tier }
	| { readonly kind: "admin"; readonly id: UserId }
	| { readonly kind: "system" };

/** The ID recorded in `ended_by` and the audit log. */
export function actorRef(actor: Actor): string {
	return actor.kind === "system" ? "system" : actor.id;
}

export type Result<T, E> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** A rejected command: a stable code for the UI and tests, plus a short explanation. */
export interface Rejection<Code extends string = string> {
	readonly code: Code;
	readonly message: string;
}

export const reject = <Code extends string>(code: Code, message: string): Result<never, Rejection<Code>> =>
	err({ code, message });

export function assertCents(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer of cents, got ${value}`);
	}
}
