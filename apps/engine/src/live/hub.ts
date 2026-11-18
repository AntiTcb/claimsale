import { LIVE_PING, LIVE_PONG, type LiveViewer as ProjectionViewer, type Millis } from "@claimsale/core";

/**
 * The SaleEngine's WebSocket fan-out (WS-H), on the Hibernation API: sockets are
 * accepted with `ctx.acceptWebSocket`, so an idle sale page costs no Durable Object
 * run time, and the viewer each socket belongs to lives in its serialized attachment,
 * which survives hibernation. Pings are answered by the runtime without waking the object.
 *
 * It knows nothing about sales: callers decide what to send and to whom. The live grid
 * uses it for item diffs (live/broadcast.ts); messaging (WS-K) can use it for
 * conversation updates with an audience filter or `sendToUser`.
 */

export type LiveRole = "seller" | "buyer" | "visitor";

/** Who is on the other end of a socket. Set once, on connect, by the engine. */
export interface LiveViewer {
	readonly userId: string | null;
	readonly role: LiveRole;
	readonly connectedAt: Millis;
}

export type Audience = (viewer: LiveViewer) => boolean;
export type Payload = Readonly<Record<string, unknown>>;
/** A payload for everyone, or one per viewer (undefined: send this viewer nothing). */
export type PayloadFor = Payload | ((viewer: LiveViewer) => Payload | undefined);

const userTag = (userId: string) => `user:${userId}`;

/** The live grid's projection viewer for a socket's viewer (core `liveItem`). */
export function projectionViewer(viewer: LiveViewer): ProjectionViewer {
	if (viewer.role === "seller") return { kind: "seller" };
	if (viewer.role === "buyer" && viewer.userId !== null) return { kind: "buyer", id: viewer.userId };
	return { kind: "visitor" };
}

function isViewer(value: unknown): value is LiveViewer {
	if (value === null || typeof value !== "object") return false;
	const role: unknown = Reflect.get(value, "role");
	return role === "seller" || role === "buyer" || role === "visitor";
}

export class LiveHub {
	constructor(readonly ctx: DurableObjectState) {
		// Heartbeats from the browser: answered by the runtime, the object stays asleep.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG));
	}

	/**
	 * Accepts a hibernatable socket for `viewer` and returns the client end for the 101
	 * response. Sockets are tagged by user, so `sendToUser` doesn't scan every socket.
	 */
	accept(viewer: LiveViewer): { client: WebSocket; server: WebSocket } {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server, viewer.userId === null ? [] : [userTag(viewer.userId)]);
		server.serializeAttachment(viewer);
		return { client, server };
	}

	viewerOf(ws: WebSocket): LiveViewer | undefined {
		const attachment: unknown = ws.deserializeAttachment();
		return isViewer(attachment) ? attachment : undefined;
	}

	/** Sends one message (`{ type, ...payload }`); false if the socket is gone. */
	send(ws: WebSocket, type: string, payload: Payload): boolean {
		return this.#sendText(ws, JSON.stringify({ type, ...payload }));
	}

	/**
	 * Sends `{ type, ...payload }` to every socket whose viewer passes `audience`. A
	 * function payload is called once per distinct viewer (role + user), so several tabs
	 * of one buyer share one projection. Returns the number of sockets sent to.
	 */
	broadcast(type: string, payload: PayloadFor, audience?: Audience): number {
		return this.#sendAll(this.ctx.getWebSockets(), type, payload, audience);
	}

	/** Like broadcast, to one user's sockets only (all their tabs). */
	sendToUser(userId: string, type: string, payload: PayloadFor): number {
		return this.#sendAll(this.ctx.getWebSockets(userTag(userId)), type, payload);
	}

	/** Closes the sockets whose viewer passes `audience` (e.g. visitors after unpublish). */
	closeWhere(audience: Audience, code: number, reason: string): number {
		let closed = 0;
		for (const ws of this.ctx.getWebSockets()) {
			const viewer = this.viewerOf(ws);
			if (!viewer || !audience(viewer)) continue;
			try {
				ws.close(code, reason);
				closed += 1;
			} catch {
				// Already closing.
			}
		}
		return closed;
	}

	/** Connected sockets, optionally only those whose viewer passes `audience`. */
	count(audience?: Audience): number {
		const sockets = this.ctx.getWebSockets();
		if (!audience) return sockets.length;
		return sockets.filter((ws) => {
			const viewer = this.viewerOf(ws);
			return viewer !== undefined && audience(viewer);
		}).length;
	}

	#sendAll(sockets: WebSocket[], type: string, payload: PayloadFor, audience?: Audience): number {
		const frames = new Map<string, string | undefined>();
		let sent = 0;
		for (const ws of sockets) {
			const viewer = this.viewerOf(ws);
			if (!viewer || (audience && !audience(viewer))) continue;
			const key = `${viewer.role}:${viewer.userId ?? ""}`;
			if (!frames.has(key)) {
				const body = typeof payload === "function" ? payload(viewer) : payload;
				frames.set(key, body === undefined ? undefined : JSON.stringify({ type, ...body }));
			}
			const frame = frames.get(key);
			if (frame !== undefined && this.#sendText(ws, frame)) sent += 1;
		}
		return sent;
	}

	#sendText(ws: WebSocket, text: string): boolean {
		try {
			ws.send(text);
			return true;
		} catch {
			// The socket closed between getWebSockets() and send(); its close handler cleans up.
			return false;
		}
	}
}
