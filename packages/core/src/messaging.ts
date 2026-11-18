import { ok, reject, type Rejection, type Result, type UserId } from "./common.ts";

/**
 * Buyer↔seller messaging (PLAN §3 "Messaging", D18; WS-K). Pure rules; the web Worker
 * stores conversations and messages in D1 and attachments in R2.
 */

export const MESSAGE_MAX_LENGTH = 2000;
export const REPORT_MAX_LENGTH = 1000;
/** Image attachments per message. */
export const MESSAGE_MAX_ATTACHMENTS = 4;

export const REPORT_REASONS = ["scam", "harassment", "spam", "off_platform_payment", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
	scam: "Scam or fraud",
	harassment: "Harassment",
	spam: "Spam",
	off_platform_payment: "Asks to pay outside the invoice",
	other: "Something else",
};

export type MessageRejection = Rejection<"empty" | "too_long" | "too_many_attachments">;

/** A message needs text or an image; text is trimmed and capped. */
export function validateMessage(
	body: string,
	attachments: number,
): Result<{ body: string }, MessageRejection> {
	const trimmed = body.trim();
	if (trimmed === "" && attachments === 0) return reject("empty", "Write a message or add a photo");
	if (trimmed.length > MESSAGE_MAX_LENGTH)
		return reject("too_long", `Keep messages under ${MESSAGE_MAX_LENGTH} characters`);
	if (attachments > MESSAGE_MAX_ATTACHMENTS)
		return reject("too_many_attachments", `Attach at most ${MESSAGE_MAX_ATTACHMENTS} photos`);
	return ok({ body: trimmed });
}

/**
 * Patterns that suggest paying outside the invoice ("pay me F&F instead"): payment apps,
 * handles and friends-and-family wording. A hint for a warning, never a block.
 */
const PAYMENT_PATTERNS: readonly RegExp[] = [
	/\bpay\s*pal\b/i,
	/\bpaypal\.me\b/i,
	/\bf\s*&\s*f\b/i,
	/\bfriends?\s*(and|&|n)\s*family\b/i,
	/\bvenmo\b/i,
	/\bcash\s*app\b/i,
	/(^|\s)\$[a-z][a-z0-9_-]{1,19}\b/i,
	/\bzelle\b/i,
	/\bapple\s*cash\b/i,
	/\b(bitcoin|btc|ethereum|eth|usdt|usdc|crypto)\b/i,
	/\bwire\s+transfer\b/i,
	/\bgift\s*cards?\b/i,
	/\bwestern\s+union\b/i,
];

/**
 * Whether a message looks like it asks for (or offers) a payment outside the invoice.
 *
 * @spec MSG-payment-warning — such messages carry a warning for the reader and the writer.
 */
export function hasPaymentHandle(text: string): boolean {
	return PAYMENT_PATTERNS.some((pattern) => pattern.test(text));
}

export interface ConversationParties {
	readonly buyerId: UserId;
	readonly sellerId: UserId;
}

export type Participant = "buyer" | "seller";

/** Which side of a conversation a user is on, or null if they aren't in it. */
export function participantOf(conversation: ConversationParties, userId: UserId | null): Participant | null {
	if (userId === null) return null;
	if (userId === conversation.buyerId) return "buyer";
	if (userId === conversation.sellerId) return "seller";
	return null;
}

export type SendRejection = Rejection<"not_participant" | "blocked" | "own_sale">;

/**
 * Whether a user may write in a conversation (or start one with this seller).
 *
 * @spec MSG-block — a buyer the seller blocked can't message them; the seller can still write.
 * @spec MSG-one-conversation — a seller doesn't open a conversation with themselves.
 */
export function canSend(
	conversation: ConversationParties,
	senderId: UserId,
	blocked: boolean,
): Result<Participant, SendRejection> {
	if (conversation.buyerId === conversation.sellerId) return reject("own_sale", "This is your own sale");
	const side = participantOf(conversation, senderId);
	if (side === null) return reject("not_participant", "You're not in this conversation");
	if (side === "buyer" && blocked) return reject("blocked", "The seller isn't accepting messages from you");
	return ok(side);
}
