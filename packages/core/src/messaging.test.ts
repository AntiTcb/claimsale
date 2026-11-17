import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	canSend,
	hasPaymentHandle,
	MESSAGE_MAX_ATTACHMENTS,
	MESSAGE_MAX_LENGTH,
	participantOf,
	validateMessage,
} from "./messaging.ts";

describe("message validation", () => {
	it("needs text or a photo, trims, and caps the length", () => {
		expect(validateMessage("  hi  ", 0)).toEqual({ ok: true, value: { body: "hi" } });
		expect(validateMessage("   ", 1)).toEqual({ ok: true, value: { body: "" } });
		expect(validateMessage("   ", 0)).toMatchObject({ ok: false, error: { code: "empty" } });
		expect(validateMessage("x".repeat(MESSAGE_MAX_LENGTH + 1), 0)).toMatchObject({
			ok: false,
			error: { code: "too_long" },
		});
		expect(validateMessage("ok", MESSAGE_MAX_ATTACHMENTS + 1)).toMatchObject({
			ok: false,
			error: { code: "too_many_attachments" },
		});
	});
});

describe("payment-handle warning", () => {
	it("[MSG-payment-warning] flags payment apps, handles and friends-and-family wording", () => {
		for (const text of [
			"just pay me F&F instead",
			"send it friends and family",
			"PayPal me at paypal.me/ash",
			"my venmo is @ash-cards",
			"cash app $ashcards",
			"Zelle works too",
			"I take BTC",
			"can you do a wire transfer",
			"Apple Cash?",
			"a gift card is fine",
		]) {
			expect({ text, flagged: hasPaymentHandle(text) }).toEqual({ text, flagged: true });
		}
	});

	it("[MSG-payment-warning] leaves ordinary questions alone", () => {
		for (const text of [
			"Can I see the back of the card?",
			"Is this near mint?",
			"Shipping to Canada costs $5?",
			"Thanks, received it!",
			"The price is $12.50",
		]) {
			expect({ text, flagged: hasPaymentHandle(text) }).toEqual({ text, flagged: false });
		}
	});

	it("[MSG-payment-warning] never throws on any input", () => {
		expect(() =>
			fc.assert(fc.property(fc.string(), (text) => typeof hasPaymentHandle(text) === "boolean")),
		).not.toThrow();
	});
});

describe("who may write", () => {
	const conversation = { buyerId: "b", sellerId: "s" };

	it("[MSG-one-conversation] only the buyer and the seller are in a conversation", () => {
		expect(participantOf(conversation, "b")).toBe("buyer");
		expect(participantOf(conversation, "s")).toBe("seller");
		expect(participantOf(conversation, "x")).toBeNull();
		expect(participantOf(conversation, null)).toBeNull();
		expect(canSend(conversation, "x", false)).toMatchObject({
			ok: false,
			error: { code: "not_participant" },
		});
		expect(canSend({ buyerId: "s", sellerId: "s" }, "s", false)).toMatchObject({
			ok: false,
			error: { code: "own_sale" },
		});
	});

	it("[MSG-block] a blocked buyer can't write; the seller still can", () => {
		expect(canSend(conversation, "b", true)).toMatchObject({ ok: false, error: { code: "blocked" } });
		expect(canSend(conversation, "b", false)).toEqual({ ok: true, value: "buyer" });
		expect(canSend(conversation, "s", true)).toEqual({ ok: true, value: "seller" });
	});
});
