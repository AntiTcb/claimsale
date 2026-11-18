import { carrierName, resolveCarrier, type Tracking } from "@claimsale/core";
import { error, fail } from "@sveltejs/kit";
import { db, invoiceEngine } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { sellerInvoice, type CommandResult } from "#lib/server/invoices.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

/**
 * One invoice, for its seller (PLAN §7): send, confirm or reject the payment, ship with
 * tracking, correct tracking, and rescind an overdue invoice. Every action is an engine
 * command; the buyer's address shows only here and on the buyer's own page.
 */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	const invoice = await sellerInvoice(db(), seller.id, sale.id, event.params.invoiceId, Date.now());
	if (!invoice) error(404, "No such invoice");
	return { invoice };
};

async function context(event: RequestEvent) {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	return { sellerId: seller.id, saleId: sale.id, invoiceId: event.params.invoiceId };
}

const answer = (action: string, result: CommandResult) =>
	result.ok ? { action, done: true as const } : fail(400, { action, message: result.error.message });

/** The carrier from the form, or detected from the number when left blank (IO-tracking-carrier). */
function trackingFrom(data: FormData): { tracking: Tracking | null } | { message: string } {
	const number = field(data, "trackingNumber").trim();
	const given = field(data, "carrier").trim();
	if (number === "") return { tracking: null };
	const carrier = carrierName(resolveCarrier(given === "" ? null : given, number));
	if (carrier === null) return { message: "Choose the carrier: we couldn't tell it from the number" };
	return { tracking: { carrier, number } };
}

export const actions: Actions = {
	/** @spec SM-6-send-after-close */
	send: async (event) => {
		const c = await context(event);
		return answer("send", await invoiceEngine().send(c.saleId, c.invoiceId, c.sellerId));
	},
	confirm: async (event) => {
		const c = await context(event);
		return answer("confirm", await invoiceEngine().confirmPaid(c.saleId, c.invoiceId, c.sellerId));
	},
	notReceived: async (event) => {
		const c = await context(event);
		return answer("notReceived", await invoiceEngine().notReceived(c.saleId, c.invoiceId, c.sellerId));
	},
	/** @spec SM-6-paid-flow */
	ship: async (event) => {
		const c = await context(event);
		const parsed = trackingFrom(await event.request.formData());
		if ("message" in parsed) return fail(400, { action: "ship", message: parsed.message });
		return answer("ship", await invoiceEngine().ship(c.saleId, c.invoiceId, c.sellerId, parsed.tracking));
	},
	/** @spec IO-tracking-replace — the form's confirmation box is required. */
	replaceTracking: async (event) => {
		const c = await context(event);
		const data = await event.request.formData();
		if (data.get("confirm") !== "on") {
			return fail(400, { action: "replaceTracking", message: "Tick the box to confirm the replacement" });
		}
		const parsed = trackingFrom(data);
		if ("message" in parsed) return fail(400, { action: "replaceTracking", message: parsed.message });
		if (parsed.tracking === null) {
			return fail(400, { action: "replaceTracking", message: "Enter the new tracking number" });
		}
		return answer(
			"replaceTracking",
			await invoiceEngine().replaceTracking(c.saleId, c.invoiceId, c.sellerId, parsed.tracking),
		);
	},
	/** @spec SM-6-overdue-rescind */
	rescindOverdue: async (event) => {
		const c = await context(event);
		return answer("rescindOverdue", await invoiceEngine().rescindOverdue(c.saleId, c.invoiceId, c.sellerId));
	},
};
