import { error, fail, redirect } from "@sveltejs/kit";
import { db, imageStore, notifyRpc } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import {
	blockBuyer,
	loadConversation,
	markRead,
	postMessage,
	readMessageForm,
	reportMessage,
	unblockBuyer,
} from "#lib/server/messaging.ts";
import { markConversationNotificationsRead } from "#lib/server/notifications.ts";
import { notifyMessagePosted } from "#lib/server/notify-rpc.ts";
import { runExit } from "#lib/server/runtime.ts";
import { requireUser } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

/** Loads the conversation for one of its two parties; anyone else gets a 404 (MSG-one-conversation). */
async function conversationFor(event: RequestEvent | Parameters<PageServerLoad>[0]) {
	const user = requireUser(event);
	const conversation = await loadConversation(db(), event.params.conversationId, user.id);
	if (!conversation) error(404, "No such conversation");
	return { user, conversation };
}

/**
 * One conversation (D18). Reading it marks it read, and its message notifications too,
 * so their delayed emails aren't sent (MSG-email-unread).
 */
export const load: PageServerLoad = async (event) => {
	const { user, conversation } = await conversationFor(event);
	const now = Date.now();
	await Promise.all([
		markRead(db(), conversation, now),
		markConversationNotificationsRead(db(), user.id, conversation.id, now),
	]);
	return { conversation };
};

export const actions: Actions = {
	send: async (event) => {
		const { user, conversation } = await conversationFor(event);
		const input = await readMessageForm(await event.request.formData());
		const posted = await postMessage(
			db(),
			imageStore(),
			{ id: conversation.id, buyerId: conversation.buyer.id, sellerId: conversation.seller.id },
			user.id,
			input,
			Date.now(),
		);
		if (!posted.ok)
			return fail(400, { action: "send" as const, error: posted.error.message, body: input.body });
		await runExit("web.messages.notify", notifyMessagePosted(notifyRpc(), posted.value.messageId));
		// Post/redirect/get: a reload doesn't send it again.
		return redirect(303, `/me/messages/${conversation.id}#latest`);
	},

	/** @spec MSG-report */
	report: async (event) => {
		const { user, conversation } = await conversationFor(event);
		const data = await event.request.formData();
		const reported = await reportMessage(
			db(),
			conversation,
			user.id,
			{ messageId: field(data, "messageId"), reason: field(data, "reason"), details: field(data, "details") },
			Date.now(),
		);
		if (!reported.ok) return fail(400, { action: "report" as const, error: reported.error.message });
		return { action: "report" as const, reported: true };
	},

	/** @spec MSG-block */
	block: async (event) => {
		const { user, conversation } = await conversationFor(event);
		const blocked = await blockBuyer(db(), conversation, user.id, Date.now());
		if (!blocked.ok) return fail(403, { action: "block" as const, error: blocked.error.message });
		return { action: "block" as const, done: true };
	},

	unblock: async (event) => {
		const { user, conversation } = await conversationFor(event);
		const unblocked = await unblockBuyer(db(), conversation, user.id);
		if (!unblocked.ok) return fail(403, { action: "unblock" as const, error: unblocked.error.message });
		return { action: "unblock" as const, done: true };
	},
};
