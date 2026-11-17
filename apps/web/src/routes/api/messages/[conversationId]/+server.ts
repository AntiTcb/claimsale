import { json } from "@sveltejs/kit";
import { db } from "#lib/server/context.ts";
import { loadConversation, markRead, messagesOf } from "#lib/server/messaging.ts";
import { markConversationNotificationsRead } from "#lib/server/notifications.ts";
import type { RequestHandler } from "./$types";

/**
 * The thread page's poll (`#lib/messaging/live.ts`): messages after `?after=` (ms). New
 * messages from the other side count as read, since the page is showing them.
 *
 * @spec MSG-one-conversation — the two parties only; anyone else gets a 404.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) return json({ message: "Sign in first" }, { status: 401 });
	const conversation = await loadConversation(db(), params.conversationId, locals.user.id);
	if (!conversation) return json({ message: "No such conversation" }, { status: 404 });
	const after = Number(url.searchParams.get("after") ?? "0");
	const messages = await messagesOf(
		db(),
		{ id: conversation.id, buyerId: conversation.buyer.id, sellerId: conversation.seller.id },
		locals.user.id,
		Number.isFinite(after) ? after : 0,
	);
	if (messages.some((m) => !m.mine)) {
		const now = Date.now();
		await Promise.all([
			markRead(db(), conversation, now),
			markConversationNotificationsRead(db(), locals.user.id, conversation.id, now),
		]);
	}
	return json({ messages }, { headers: { "cache-control": "no-store" } });
};
