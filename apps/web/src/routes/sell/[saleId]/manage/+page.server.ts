import { fail, type RequestEvent } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { loadControlRoom, runControlAction, type ControlAction } from "#lib/server/control-room.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The seller's control room (PLAN §7): per-item queues, deciding countdowns, award /
 * decline / counter, reorder, rescind with a reason, the take-back inbox and buyer
 * records. Data loads on the server; the page refreshes after each action (live
 * updates over the sale's socket can come later, WS-H).
 */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	return { room: await loadControlRoom(db(), sale.id), now: Date.now() };
};

async function act(event: RequestEvent<{ saleId: string }>, action: ControlAction) {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	const data = await event.request.formData();
	const result = await runControlAction(
		db(),
		env.ENGINE,
		{ saleId: sale.id, sellerId: seller.id },
		action,
		data,
	);
	const target = { action, entryId: field(data, "entryId") || field(data, "requestId") };
	if (!result.ok) {
		const status = result.error.code === "engine_unavailable" ? 503 : 400;
		return fail(status, { ...target, code: result.error.code, message: result.error.message });
	}
	return { ...target, message: result.value };
}

export const actions: Actions = {
	award: (event) => act(event, "award"),
	decline: (event) => act(event, "decline"),
	counter: (event) => act(event, "counter"),
	moveBackup: (event) => act(event, "moveBackup"),
	rescind: (event) => act(event, "rescind"),
	approveTakeback: (event) => act(event, "approveTakeback"),
	denyTakeback: (event) => act(event, "denyTakeback"),
	withdrawItem: (event) => act(event, "withdrawItem"),
};
