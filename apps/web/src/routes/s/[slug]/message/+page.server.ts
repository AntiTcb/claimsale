import { error, fail, redirect } from "@sveltejs/kit";
import { db, imageStore, notifyRpc } from "#lib/server/context.ts";
import {
	findBuyerConversation,
	isBlocked,
	openConversation,
	postMessage,
	readMessageForm,
} from "#lib/server/messaging.ts";
import { notifyMessagePosted } from "#lib/server/notify-rpc.ts";
import { runExit } from "#lib/server/runtime.ts";
import { loadSaleForViewer, saleHeader } from "#lib/server/sale-view.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

/**
 * A buyer's first message to the seller of a sale they can see (D18: "can I see the back of
 * the card?" before claiming). An existing conversation opens instead.
 *
 * @spec MSG-one-conversation
 * @spec SM-2-visibility — a sale the viewer can't open can't be messaged about either.
 */
async function saleFor(event: RequestEvent | Parameters<PageServerLoad>[0]) {
	const user = requireUser(event);
	const { sale, access, isSeller } = await loadSaleForViewer(event, event.params.slug);
	if (access === "locked") redirect(303, `/s/${sale.slug}`);
	if (isSeller) redirect(303, "/me/messages");
	if (sale.status === "draft") error(404, "No such sale");
	return { user, sale };
}

export const load: PageServerLoad = async (event) => {
	const { user, sale } = await saleFor(event);
	const existing = await findBuyerConversation(db(), sale.id, user.id);
	if (existing?.lastMessageAt) redirect(303, `/me/messages/${existing.id}`);
	return { header: saleHeader(sale), blocked: await isBlocked(db(), sale.sellerId, user.id) };
};

export const actions: Actions = {
	send: async (event) => {
		const { user, sale } = await saleFor(event);
		const input = await readMessageForm(await event.request.formData());
		const now = Date.now();
		const opened = await openConversation(db(), { id: sale.id, sellerId: sale.sellerId }, user.id, now);
		if (!opened.ok) return fail(400, { error: opened.error.message, body: input.body });
		const posted = await postMessage(db(), imageStore(), opened.value, user.id, input, now);
		if (!posted.ok) return fail(400, { error: posted.error.message, body: input.body });
		await runExit("web.messages.notify", notifyMessagePosted(notifyRpc(), posted.value.messageId));
		return redirect(303, `/me/messages/${opened.value.id}`);
	},
};
