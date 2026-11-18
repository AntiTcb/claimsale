import {
	LIVE_CLOSE_NOT_VISIBLE,
	LIVE_VIEWER_HEADER,
	type LiveItem,
	type LiveMessage,
	type LiveSnapshot,
} from "@claimsale/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, claim, DAY, engine, makeSale, offer, uid, value, type SaleSetup } from "./sale-fixtures.ts";

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	quiet = [vi.spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
	for (const socket of open.splice(0)) {
		try {
			socket.ws.close();
		} catch {
			// Closed by the server.
		}
	}
});

const open: Socket[] = [];

/** A browser's end of the live socket: every frame it got, and a way to wait for the next one. */
class Socket {
	readonly frames: LiveMessage[] = [];
	readonly raw: string[] = [];
	closed: { code: number; reason: string } | undefined;
	#waiters: Array<() => void> = [];

	constructor(readonly ws: WebSocket) {
		ws.addEventListener("message", (event) => {
			const text = String(event.data);
			this.raw.push(text);
			if (text !== "pong") this.frames.push(JSON.parse(text) as LiveMessage);
			this.#wake();
		});
		ws.addEventListener("close", (event) => {
			this.closed = { code: event.code, reason: event.reason };
			this.#wake();
		});
		ws.accept();
	}

	#wake() {
		for (const waiter of this.#waiters.splice(0)) waiter();
	}

	/** Waits until a frame matches, and returns it. */
	async next<T extends LiveMessage["type"]>(
		type: T,
		match: (frame: Extract<LiveMessage, { type: T }>) => boolean = () => true,
	): Promise<Extract<LiveMessage, { type: T }>> {
		const deadline = Date.now() + 5000;
		for (;;) {
			const found = this.frames.find(
				(f): f is Extract<LiveMessage, { type: T }> =>
					f.type === type && match(f as Extract<LiveMessage, { type: T }>),
			);
			if (found) return found;
			if (Date.now() > deadline) throw new Error(`no "${type}" frame; got ${JSON.stringify(this.frames)}`);
			await new Promise<void>((resolve) => {
				this.#waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
	}

	async untilClosed(): Promise<{ code: number; reason: string }> {
		const deadline = Date.now() + 5000;
		while (!this.closed) {
			if (Date.now() > deadline) throw new Error("socket stayed open");
			await new Promise<void>((resolve) => {
				this.#waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
		return this.closed;
	}

	/** The latest projection of one item this socket got (snapshot or diff). */
	item(itemId: string): LiveItem | undefined {
		let latest: LiveItem | undefined;
		for (const frame of this.frames) {
			const items = frame.type === "snapshot" || frame.type === "items" ? frame.items : [];
			for (const item of items) {
				if (item.id === itemId && (!latest || item.version >= latest.version)) latest = item;
			}
		}
		return latest;
	}
}

function upgrade(saleId: string, viewerId: string | null, headers: Record<string, string> = {}) {
	return engine.fetch(
		new Request(`https://engine/live/${encodeURIComponent(saleId)}`, {
			headers: {
				Upgrade: "websocket",
				...(viewerId === null ? {} : { [LIVE_VIEWER_HEADER]: viewerId }),
				...headers,
			},
		}),
	);
}

async function connect(saleId: string, viewerId: string | null): Promise<Socket> {
	const response = await upgrade(saleId, viewerId);
	expect(response.status).toBe(101);
	const socket = new Socket(response.webSocket!);
	open.push(socket);
	await socket.next("snapshot");
	return socket;
}

const itemOf = (sale: SaleSetup) => sale.itemIds[0]!;
const settled = (s: Socket) => s.next("items", (f) => f.items[0]!.version === 2);

describe("the live socket", () => {
	it("sends server time, then a snapshot of every item, on connect [LIVE-broadcast]", async () => {
		const sale = await makeSale({ items: [{ title: "A" }, { title: "B", priceCents: 1250 }] });
		const before = Date.now();
		const socket = await connect(sale.saleId, null);
		expect(socket.frames[0]).toMatchObject({ type: "hello", protocol: 1 });
		const hello = socket.frames[0] as Extract<LiveMessage, { type: "hello" }>;
		expect(hello.serverNow).toBeGreaterThanOrEqual(before);
		const snapshot = await socket.next("snapshot");
		expect(snapshot.sale).toMatchObject({ status: "live" });
		expect(snapshot.items.map((i) => i.id)).toEqual(sale.itemIds);
		expect(snapshot.items[0]).toMatchObject({
			version: 0,
			state: "available",
			claimCount: 0,
			offerCount: 0,
			freeUnits: 1,
			mine: [],
		});
	});

	it("answers the browser's ping without a frame of its own [LIVE-broadcast]", async () => {
		const sale = await makeSale();
		const socket = await connect(sale.saleId, null);
		socket.ws.send("ping");
		const deadline = Date.now() + 5000;
		while (!socket.raw.includes("pong")) {
			if (Date.now() > deadline) throw new Error("no pong");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(socket.frames.map((f) => f.type)).toEqual(["hello", "snapshot"]);
	});

	it("pushes each commit to every viewer with the item's new version [LIVE-broadcast]", async () => {
		const sale = await makeSale();
		const [ann, bob] = [await addUser(uid("ann")), await addUser(uid("bob"))];
		const visitor = await connect(sale.saleId, null);
		const bobSocket = await connect(sale.saleId, bob);

		value(await claim(sale, ann));
		const seen = await visitor.next("items");
		expect(seen.items).toEqual([
			expect.objectContaining({ id: itemOf(sale), version: 1, state: "sold_out", unitsWon: 1, mine: [] }),
		]);
		expect((await bobSocket.next("items")).items[0]).toMatchObject({
			version: 1,
			state: "sold_out",
			mine: [],
		});

		// Bob's backup claim: version 2 reaches the visitor too, with the new count.
		value(await claim(sale, bob));
		expect((await visitor.next("items", (f) => f.items[0]!.version === 2)).items[0]).toMatchObject({
			claimCount: 1,
			mine: [],
		});
	});

	it("two buyers claim one copy at once: one is #1, the other backup #1, and both sockets say so [LIVE-position] [SM-9-serialized-writes]", async () => {
		const sale = await makeSale();
		const [ann, bob] = [await addUser(uid("ann")), await addUser(uid("bob"))];
		const annSocket = await connect(sale.saleId, ann);
		const bobSocket = await connect(sale.saleId, bob);
		await Promise.all([claim(sale, ann), claim(sale, bob)]);

		await Promise.all([settled(annSocket), settled(bobSocket)]);
		const positions = [annSocket, bobSocket].map((s) => s.item(itemOf(sale))!.mine[0]!.position);
		expect(positions).toEqual(
			expect.arrayContaining([
				{ kind: "won", rank: 1 },
				{ kind: "backup", rank: 1 },
			]),
		);
	});

	it("never sends one buyer another buyer's ID, and offer amounts only as the sale's visibility allows [LIVE-no-leak] [SM-3-offer-visibility]", async () => {
		const blind = await makeSale({ items: [{ priceCents: 4000 }] });
		const [ann, bob] = [await addUser(uid("ann")), await addUser(uid("bob"))];
		const bobSocket = await connect(blind.saleId, bob);
		const seller = await connect(blind.saleId, blind.sellerId);
		value(await offer(blind, ann, 3300));
		const bobView = await bobSocket.next("items");
		expect(bobView.items[0]).toMatchObject({ offerCount: 1, offers: [] });
		expect(bobSocket.raw.join("")).not.toContain(ann);
		expect(bobSocket.raw.join("")).not.toContain("3300");
		// The seller sees the amount, still without the buyer's ID on the grid.
		expect((await seller.next("items")).items[0]!.offers).toEqual([{ label: "Buyer A", amountCents: 3300 }]);
		expect(seller.raw.join("")).not.toContain(ann);

		const visible = await makeSale({ terms: { offerVisibility: "visible" } });
		const bobOnVisible = await connect(visible.saleId, bob);
		value(await offer(visible, ann, 3300));
		expect((await bobOnVisible.next("items")).items[0]!.offers).toEqual([
			{ label: "Buyer A", amountCents: 3300 },
		]);
		expect(bobOnVisible.raw.join("")).not.toContain(ann);
	});

	it("tells everyone when the sale closes, with every item's closed state [LIVE-broadcast]", async () => {
		const sale = await makeSale({ items: [{}, {}] });
		const socket = await connect(sale.saleId, null);
		value(await engine.closeSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
		expect((await socket.next("sale")).sale).toMatchObject({ status: "closed" });
		const items = await socket.next("items");
		expect(items.items.map((i) => [i.id, i.state, i.version])).toEqual(
			sale.itemIds.map((id) => [id, "unsold", 1]),
		);
	});
});

describe("who may open the live socket", () => {
	it("a draft is the seller's alone [LIVE-access] [SM-2-visibility]", async () => {
		const sale = await makeSale({ status: "draft" });
		expect((await upgrade(sale.saleId, null)).status).toBe(404);
		expect((await upgrade(sale.saleId, await addUser(uid("buyer")))).status).toBe(404);
		const seller = await connect(sale.saleId, sale.sellerId);
		expect((await seller.next("snapshot")).sale.status).toBe("draft");
		expect((await upgrade(uid("missing"), null)).status).toBe(404);
	});

	it("unpublishing closes every socket but the seller's [LIVE-access]", async () => {
		const sale = await makeSale({
			status: "scheduled",
			liveAt: Date.now() + DAY,
			closesAt: Date.now() + 3 * DAY,
		});
		const visitor = await connect(sale.saleId, null);
		const buyer = await connect(sale.saleId, await addUser(uid("buyer")));
		const seller = await connect(sale.saleId, sale.sellerId);
		value(await engine.unpublishSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
		expect(await visitor.untilClosed()).toMatchObject({ code: LIVE_CLOSE_NOT_VISIBLE });
		expect(await buyer.untilClosed()).toMatchObject({ code: LIVE_CLOSE_NOT_VISIBLE });
		expect((await seller.next("sale")).sale.status).toBe("draft");
		expect(seller.closed).toBeUndefined();
	});

	it("only takes WebSocket upgrades on /live/<saleId>", async () => {
		const sale = await makeSale();
		const plain = await engine.fetch(new Request(`https://engine/live/${sale.saleId}`));
		expect(plain.status).toBe(426);
		expect((await engine.fetch(new Request("https://engine/"))).status).toBe(404);
		expect((await engine.fetch(new Request(`https://engine/live/${sale.saleId}/x`))).status).toBe(404);
	});
});

describe("the live snapshot over RPC", () => {
	it("projects every item for the viewer, and is null where the sale doesn't exist for them [LIVE-no-leak] [LIVE-access]", async () => {
		const sale = await makeSale({ items: [{ priceCents: 1500 }] });
		const ann = await addUser(uid("ann"));
		value(await claim(sale, ann));
		const result = await engine.liveSnapshot({ saleId: sale.saleId, viewerId: ann });
		if (!result.ok) throw new Error(result.error.message);
		const snapshot: LiveSnapshot | null = result.value;
		expect(snapshot?.items[0]?.mine[0]).toMatchObject({
			status: "won",
			amountCents: 1500,
			position: { kind: "won", rank: 1 },
		});
		const visitor = await engine.liveSnapshot({ saleId: sale.saleId, viewerId: null });
		expect(visitor.ok && visitor.value?.items[0]?.mine).toEqual([]);

		const draft = await makeSale({ status: "draft" });
		expect(await engine.liveSnapshot({ saleId: draft.saleId, viewerId: ann })).toEqual({
			ok: true,
			value: null,
		});
		const forSeller = await engine.liveSnapshot({ saleId: draft.saleId, viewerId: draft.sellerId });
		expect(forSeller.ok && forSeller.value?.sale.status).toBe("draft");
	});
});
