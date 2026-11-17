import type { Millis } from "./common.ts";
import type { Invoice } from "./invoice.ts";
import { AUTOCOMPLETE_AFTER } from "./plans.ts";
import type { Item } from "./item.ts";
import { mutualAnswerDueAt, type Rescind } from "./rescind.ts";
import type { Sale } from "./sale.ts";

/** Timers (STATE_MACHINES §7). Each sale's Durable Object keeps one alarm. */

export type Timer =
	| { readonly kind: "sale_live"; readonly at: Millis }
	| { readonly kind: "sale_close"; readonly at: Millis }
	| { readonly kind: "decision_deadline"; readonly at: Millis; readonly itemId: string }
	| { readonly kind: "offers_lapse"; readonly at: Millis; readonly itemId: string }
	| {
			readonly kind: "counter_expiry";
			readonly at: Millis;
			readonly itemId: string;
			readonly entryId: string;
	  }
	| { readonly kind: "invoice_due"; readonly at: Millis; readonly invoiceId: string }
	| { readonly kind: "invoice_autocomplete"; readonly at: Millis; readonly invoiceId: string }
	| { readonly kind: "mutual_answer_due"; readonly at: Millis; readonly rescindId: string };

/** A seller rescind of the sale, with its ID (for the mutual-agreement answer timer). */
export interface RescindOfSale {
	readonly id: string;
	readonly rescind: Rescind;
}

/**
 * Every pending timer of one sale.
 *
 * @spec SM-4.3.1-mutual — a mutual-agreement rescind waiting for the buyer is a timer at 72h.
 */
export function pendingTimers(
	sale: Sale,
	items: readonly Item[],
	invoices: readonly Invoice[],
	rescinds: readonly RescindOfSale[] = [],
): Timer[] {
	const timers: Timer[] = [];
	for (const { id, rescind } of rescinds) {
		const at = mutualAnswerDueAt(rescind);
		if (at !== null) timers.push({ kind: "mutual_answer_due", at, rescindId: id });
	}
	if (sale.status === "scheduled" && sale.liveAt !== null)
		timers.push({ kind: "sale_live", at: sale.liveAt });
	if ((sale.status === "scheduled" || sale.status === "live") && sale.closesAt !== null) {
		timers.push({ kind: "sale_close", at: sale.closesAt });
	}
	for (const item of items) {
		if (item.decisionDeadline !== null)
			timers.push({ kind: "decision_deadline", at: item.decisionDeadline, itemId: item.id });
		if (item.offersLapseAt !== null)
			timers.push({ kind: "offers_lapse", at: item.offersLapseAt, itemId: item.id });
		for (const entry of item.entries) {
			if (entry.status === "countered" && entry.counterExpiresAt !== null) {
				timers.push({
					kind: "counter_expiry",
					at: entry.counterExpiresAt,
					itemId: item.id,
					entryId: entry.id,
				});
			}
		}
	}
	for (const invoice of invoices) {
		if (invoice.status === "sent" && invoice.dueAt !== null) {
			timers.push({ kind: "invoice_due", at: invoice.dueAt, invoiceId: invoice.id });
		}
		if (invoice.status === "shipped" && invoice.shippedAt !== null) {
			timers.push({
				kind: "invoice_autocomplete",
				at: invoice.shippedAt + AUTOCOMPLETE_AFTER,
				invoiceId: invoice.id,
			});
		}
	}
	return timers;
}

/**
 * When to set the sale's single alarm, and what to process when it fires.
 *
 * @spec SM-7-single-alarm — one alarm at the earliest pending timer; when it fires,
 * everything due is processed (earliest first), then the alarm is re-armed.
 */
export function nextAlarm(timers: readonly Timer[]): Millis | null {
	let earliest: Millis | null = null;
	for (const timer of timers) if (earliest === null || timer.at < earliest) earliest = timer.at;
	return earliest;
}

/** @spec SM-7-single-alarm */
export function dueTimers(timers: readonly Timer[], now: Millis): Timer[] {
	return timers.filter((timer) => timer.at <= now).toSorted((a, b) => a.at - b.at);
}
