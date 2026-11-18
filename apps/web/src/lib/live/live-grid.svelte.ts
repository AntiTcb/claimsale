import {
	LIVE_CLOSE_NOT_FOUND,
	LIVE_CLOSE_NOT_VISIBLE,
	LIVE_PING,
	runningTotal,
	type LiveItem,
	type LiveMessage,
	type LiveSale,
	type LiveSnapshot,
} from "@claimsale/core";
import { announcements, mergeItems, mergeSale, saleAnnouncement, type LiveItems } from "./state.ts";

/**
 * One sale page's live state (WS-H): the items as the engine projected them for this
 * viewer, the sale's status, the server clock, and what to announce. It starts from the
 * page load's snapshot and follows the sale's WebSocket; every (re)connect brings a
 * fresh snapshot, so a dropped connection catches up on its own.
 */

export type ConnectionState = "connecting" | "live" | "offline" | "closed";

export interface LiveGridOptions {
	/** Item titles, for announcements. */
	readonly titles: Readonly<Record<string, string>>;
	/** Called when the socket mentions an item the page doesn't have, or the sale went away. */
	readonly onStale?: () => void;
	/** Follow one item only (the item page): the socket's other items are ignored. */
	readonly itemId?: string;
}

const PING_EVERY = 25_000;

const MESSAGE_TYPES: ReadonlySet<unknown> = new Set(["hello", "snapshot", "sale", "items"]);

/** A frame from the engine; undefined for anything that isn't JSON or isn't one of ours. */
function parseMessage(text: string): LiveMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || !MESSAGE_TYPES.has(Reflect.get(value, "type"))) {
		return undefined;
	}
	// The engine is trusted, and `type` names one of the LiveMessage shapes it sends.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return value as LiveMessage;
}
const MAX_BACKOFF = 15_000;

export class LiveGrid {
	items: LiveItems = $state.raw({});
	sale: LiveSale | null = $state.raw(null);
	/** Server clock minus this browser's clock, in ms (PLAN §5: countdowns use server time). */
	serverOffset = $state(0);
	connection: ConnectionState = $state("connecting");
	/** The latest announcement, for the page's live region. */
	announcement = $state("");
	/** Bumped with each announcement, so the same sentence twice is still read out. */
	announcementId = $state(0);

	readonly #options: LiveGridOptions;
	/** The items the page shows, by ID (starts as `options.titles`; see setTitles). */
	#titles: Readonly<Record<string, string>>;
	#socket: WebSocket | undefined;
	#url: string | undefined;
	#attempt = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#ping: ReturnType<typeof setInterval> | undefined;
	#stopped = false;

	constructor(snapshot: LiveSnapshot | null, options: LiveGridOptions) {
		this.#options = options;
		this.#titles = options.titles;
		if (snapshot) {
			this.items = Object.fromEntries(snapshot.items.map((i) => [i.id, i]));
			this.sale = snapshot.sale;
			this.serverOffset = snapshot.serverNow - Date.now();
		}
	}

	/** The buyer's running total in this sale (D53). */
	get total(): { cents: number; count: number } {
		return runningTotal(Object.values(this.items));
	}

	/** The server's clock now. */
	now(): number {
		return Date.now() + this.serverOffset;
	}

	announce(text: string): void {
		this.announcement = text;
		this.announcementId += 1;
	}

	/** The page's items after a refetch, so items it now shows aren't "unknown" or "deleted". */
	setTitles(titles: Readonly<Record<string, string>>): void {
		this.#titles = titles;
	}

	/** Applies one message from the socket (also used by tests). */
	apply(message: LiveMessage): void {
		switch (message.type) {
			case "hello":
				this.serverOffset = message.serverNow - Date.now();
				return;
			case "snapshot": {
				this.serverOffset = message.serverNow - Date.now();
				this.#applySale(message.sale);
				const items = this.#followed(message.items);
				this.#applyItems(items);
				// A snapshot lists every item: one the page shows but the snapshot lacks was
				// deleted (the seller's editor), so the page refetches (LIVE-broadcast).
				const listed = new Set(items.map((i) => i.id));
				// After the seller's edit, the page's own titles, prices and photos may be stale.
				if (message.edited || Object.keys(this.#titles).some((id) => !listed.has(id)))
					this.#options.onStale?.();
				return;
			}
			case "sale":
				this.#applySale(message.sale);
				return;
			case "items":
				this.#applyItems(this.#followed(message.items));
				return;
		}
	}

	#followed(items: readonly LiveItem[]): readonly LiveItem[] {
		const only = this.#options.itemId;
		return only === undefined ? items : items.filter((i) => i.id === only);
	}

	#applySale(sale: LiveSale): void {
		const before = this.sale;
		const next = mergeSale(before, sale);
		if (next === before) return;
		this.sale = next;
		const text = saleAnnouncement(before, next);
		if (text) this.announce(text);
	}

	#applyItems(incoming: readonly LiveItem[]): void {
		const before = this.items;
		const { items, changed, unknown } = mergeItems(before, incoming);
		this.items = items;
		const lines = changed.flatMap((item) =>
			announcements(before[item.id], item, this.#titles[item.id] ?? "This item"),
		);
		if (lines.length > 0) this.announce(lines.join(" "));
		// An item added after the page loaded: the page refetches to get its title and photo.
		if (unknown.some((id) => !(id in this.#titles))) this.#options.onStale?.();
	}

	/** Opens the socket and keeps it open (backoff on failures) until stop(). */
	connect(url: string): void {
		this.#url = url;
		this.#stopped = false;
		this.#open();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		clearInterval(this.#ping);
		this.#socket?.close();
		this.#socket = undefined;
		this.connection = "closed";
	}

	#open(): void {
		if (this.#stopped || !this.#url || typeof WebSocket === "undefined") return;
		this.connection = "connecting";
		const socket = new WebSocket(this.#url);
		this.#socket = socket;
		socket.addEventListener("open", () => {
			this.#attempt = 0;
			this.connection = "live";
			clearInterval(this.#ping);
			this.#ping = setInterval(
				() => socket.readyState === WebSocket.OPEN && socket.send(LIVE_PING),
				PING_EVERY,
			);
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data === "pong") return;
			const message = parseMessage(event.data);
			// A frame this version doesn't understand is skipped: the next snapshot fixes the state.
			if (message) this.apply(message);
		});
		socket.addEventListener("close", (event) => {
			clearInterval(this.#ping);
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			if (this.#stopped) return;
			if (event.code === LIVE_CLOSE_NOT_VISIBLE || event.code === LIVE_CLOSE_NOT_FOUND) {
				this.connection = "closed";
				this.#options.onStale?.();
				return;
			}
			this.connection = "offline";
			const delay = Math.min(MAX_BACKOFF, 500 * 2 ** this.#attempt) * (0.5 + Math.random() / 2);
			this.#attempt += 1;
			this.#timer = setTimeout(() => this.#open(), delay);
		});
	}
}
