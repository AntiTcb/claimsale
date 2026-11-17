/**
 * Keeps an open conversation up to date (PLAN §3 "Messaging": realtime).
 *
 * THE SEAM: today this polls `GET /api/messages/[conversationId]?after=` every few seconds
 * while the tab is visible (and at once when it becomes visible again). The sale's
 * Durable Object WebSocket (WS-H) will carry live updates; when its broadcast helper
 * lands, replace `pollTransport` with a subscription to the conversation's channel and
 * keep `watchConversation`'s signature, so the thread page doesn't change. Message
 * writes stay form actions either way.
 */

export interface LiveMessage {
	readonly id: string;
	readonly createdAt: number;
}

export interface Feed {
	stop(): void;
}

export interface WatchOptions<M> {
	/** Checks one message from the server; anything it rejects (null) is dropped. */
	readonly parse: (raw: unknown) => M | null;
	/** Poll interval in ms. */
	readonly interval?: number;
	readonly fetch?: typeof fetch;
	readonly document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

export const POLL_INTERVAL = 5000;

/**
 * Calls `onMessages` with messages newer than the newest one seen so far. `after` is the
 * newest message the page rendered (ms).
 */
export function watchConversation<M extends LiveMessage>(
	conversationId: string,
	after: number,
	onMessages: (messages: M[]) => void,
	options: WatchOptions<M>,
): Feed {
	return pollTransport(conversationId, after, onMessages, options);
}

function pollTransport<M extends LiveMessage>(
	conversationId: string,
	after: number,
	onMessages: (messages: M[]) => void,
	options: WatchOptions<M>,
): Feed {
	const doFetch = options.fetch ?? fetch;
	const doc = options.document ?? document;
	let newest = after;
	let stopped = false;
	let inFlight = false;
	const seen = new Set<string>();

	async function poll(): Promise<void> {
		if (stopped || inFlight || doc.visibilityState === "hidden") return;
		inFlight = true;
		try {
			const res = await doFetch(`/api/messages/${encodeURIComponent(conversationId)}?after=${newest}`, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) return;
			const body: unknown = await res.json();
			const raw: unknown[] =
				typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages)
					? body.messages
					: [];
			const fresh = raw.map((m) => options.parse(m)).filter((m): m is M => m !== null && !seen.has(m.id));
			for (const m of fresh) {
				seen.add(m.id);
				newest = Math.max(newest, m.createdAt);
			}
			if (fresh.length > 0 && !stopped) onMessages(fresh);
		} catch {
			// Offline or a deploy in progress: the next tick tries again.
		} finally {
			inFlight = false;
		}
	}

	const timer = setInterval(() => void poll(), options.interval ?? POLL_INTERVAL);
	const onVisible = () => {
		if (doc.visibilityState === "visible") void poll();
	};
	doc.addEventListener("visibilitychange", onVisible);
	return {
		stop() {
			stopped = true;
			clearInterval(timer);
			doc.removeEventListener("visibilitychange", onVisible);
		},
	};
}
