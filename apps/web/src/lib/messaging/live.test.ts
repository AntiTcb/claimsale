import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchConversation } from "./live.ts";
import { parseThreadMessage, type ThreadMessage } from "./thread.ts";

const message = (id: string, createdAt: number): ThreadMessage => ({
	id,
	mine: false,
	senderName: "Ash",
	body: "hi",
	paymentWarning: false,
	createdAt,
	attachments: [],
});

function fakeDocument() {
	const listeners = new Set<() => void>();
	return {
		visibilityState: "visible" as DocumentVisibilityState,
		addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
		fire: () => {
			for (const l of listeners) l();
		},
		listeners,
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("conversation feed (poll transport)", () => {
	it("polls for messages after the newest one seen and delivers each once", async () => {
		const urls: string[] = [];
		const replies = [[message("a", 10), message("b", 20)], [message("b", 20), message("c", 30)], []];
		const fetch = async (url: string | URL | Request) => {
			if (typeof url !== "string") throw new Error("expected a path");
			const text = url;
			urls.push(text);
			return Response.json({ messages: replies.shift() ?? [] });
		};
		const got: string[] = [];
		const doc = fakeDocument();
		const feed = watchConversation("conv 1", 5, (m) => got.push(...m.map((x) => x.id)), {
			parse: parseThreadMessage,
			interval: 1000,
			fetch,
			document: doc as unknown as Document,
		});
		await vi.advanceTimersByTimeAsync(3000);
		expect(urls).toEqual([
			"/api/messages/conv%201?after=5",
			"/api/messages/conv%201?after=20",
			"/api/messages/conv%201?after=30",
		]);
		expect(got).toEqual(["a", "b", "c"]);
		feed.stop();
		expect(doc.listeners.size).toBe(0);
		await vi.advanceTimersByTimeAsync(3000);
		expect(urls).toHaveLength(3);
	});

	it("doesn't poll a hidden tab, and catches up when it becomes visible", async () => {
		let fetched = 0;
		const fetch = async () => {
			fetched++;
			return Response.json({ messages: [message("a", 1), { junk: true }] });
		};
		const doc = fakeDocument();
		doc.visibilityState = "hidden";
		const got: ThreadMessage[] = [];
		const feed = watchConversation("c", 0, (m) => got.push(...m), {
			parse: parseThreadMessage,
			interval: 1000,
			fetch,
			document: doc as unknown as Document,
		});
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetched).toBe(0);
		doc.visibilityState = "visible";
		doc.fire();
		await vi.advanceTimersByTimeAsync(0);
		expect(got.map((m) => m.id)).toEqual(["a"]);
		feed.stop();
	});

	it("survives failed requests", async () => {
		let calls = 0;
		const fetch = async () => {
			calls++;
			if (calls === 1) throw new Error("offline");
			if (calls === 2) return new Response("nope", { status: 500 });
			return Response.json({ messages: [message("a", 1)] });
		};
		const got: string[] = [];
		const feed = watchConversation("c", 0, (m) => got.push(...m.map((x) => x.id)), {
			parse: parseThreadMessage,
			interval: 1000,
			fetch,
			document: fakeDocument() as unknown as Document,
		});
		await vi.advanceTimersByTimeAsync(3000);
		expect(got).toEqual(["a"]);
		feed.stop();
	});
});

describe("parseThreadMessage", () => {
	it("accepts a message and rejects anything else", () => {
		const good = {
			...message("a", 1),
			attachments: [{ id: "p", url: "/api/messages/attachments/p", width: 1, height: null }, { id: 3 }],
		};
		expect(parseThreadMessage(good)).toEqual({
			...good,
			attachments: [{ id: "p", url: "/api/messages/attachments/p", width: 1, height: null }],
		});
		expect(parseThreadMessage({ ...good, createdAt: "1" })).toBeNull();
		expect(parseThreadMessage(null)).toBeNull();
		expect(parseThreadMessage([good])).toBeNull();
	});
});
