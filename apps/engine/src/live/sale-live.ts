import {
	LIVE_CLOSE_NOT_FOUND,
	LIVE_CLOSE_NOT_VISIBLE,
	LIVE_PROTOCOL,
	LIVE_VIEWER_HEADER,
	liveItem,
	type LiveSale,
	type LiveSnapshot,
	type Millis,
} from "@claimsale/core";
import { loadSale, loadSaleAndItems, type SaleRecord, type Work } from "../sale/store.ts";
import { projectionViewer, type LiveHub, type LiveRole, type LiveViewer } from "./hub.ts";

/**
 * The live grid over the SaleEngine's sockets (WS-H, PLAN §5 "Realtime details"):
 * the snapshot a viewer gets on connect, and the diff every commit sends.
 */

/**
 * The web Worker's verified viewer, on the forwarded upgrade request. The engine has no
 * public route (`workers_dev: false`, no routes): only the web Worker's service binding
 * reaches its `fetch`, after checking the session and the sale's access.
 */
export const VIEWER_HEADER = LIVE_VIEWER_HEADER;

/** The path of a sale's socket on the engine (`/live/<saleId>`); undefined for any other path. */
export function parseLivePath(pathname: string): string | undefined {
	const match = /^\/live\/([^/]+)$/.exec(pathname);
	if (!match) return undefined;
	try {
		const saleId = decodeURIComponent(match[1]!);
		return saleId.length > 0 && saleId.length <= 64 ? saleId : undefined;
	} catch {
		return undefined;
	}
}

export function roleFor(sale: Pick<SaleRecord, "sellerId">, userId: string | null): LiveRole {
	if (userId === null) return "visitor";
	return userId === sale.sellerId ? "seller" : "buyer";
}

/** A draft is the seller's alone (SM-2-visibility); deleted sales are no one's. */
const visibleTo = (status: SaleRecord["sale"]["status"], role: LiveRole) =>
	status !== "deleted" && (status !== "draft" || role === "seller");

const saleView = (sale: SaleRecord["sale"], at: Millis): LiveSale => ({
	status: sale.status,
	liveAt: sale.liveAt,
	closesAt: sale.closesAt,
	at,
});

/**
 * Every item of the sale as `userId` may see it, or undefined when the sale doesn't
 * exist for them. The web Worker renders the page from this; the socket sends it on
 * every connect, which is how a reconnecting browser catches up.
 *
 * @spec LIVE-no-leak — every item goes through core's `liveItem` projection for this viewer.
 */
export async function loadLiveSnapshot(
	db: D1Database,
	saleId: string,
	userId: string | null,
	now: Millis,
): Promise<LiveSnapshot | undefined> {
	const loaded = await loadSaleAndItems(db, saleId, "all", now);
	const sale = loaded.sale;
	if (!sale) return undefined;
	const role = roleFor(sale, userId);
	if (!visibleTo(sale.sale.status, role)) return undefined;
	const viewer = projectionViewer({ userId, role, connectedAt: now });
	return {
		serverNow: now,
		sale: saleView(sale.sale, now),
		items: [...loaded.items.values()].map((slot) =>
			liveItem(slot.item, slot.version, sale.sale.status, sale.settings.offerVisibility, viewer),
		),
	};
}

/**
 * Accepts a live socket. The socket is accepted before the snapshot is read, so a
 * commit that lands in between reaches it as a diff; the browser keeps the highest
 * item version, so the order of the two doesn't matter.
 *
 * @spec LIVE-broadcast — server time first, then a full snapshot on every connect.
 * @spec LIVE-access — drafts only for their seller; the web Worker checked private-sale access.
 */
export async function connectLive(
	hub: LiveHub,
	db: D1Database,
	saleId: string,
	userId: string | null,
	now: Millis,
): Promise<Response> {
	const sale = await loadSale(db, saleId, now);
	const role = sale ? roleFor(sale, userId) : "visitor";
	if (!sale || !visibleTo(sale.sale.status, role)) return new Response("Not found", { status: 404 });
	const { client, server } = hub.accept({ userId, role, connectedAt: now });
	hub.send(server, "hello", { protocol: LIVE_PROTOCOL, serverNow: now });
	const snapshot = await loadLiveSnapshot(db, saleId, userId, now);
	if (snapshot) hub.send(server, "snapshot", { ...snapshot });
	else server.close(LIVE_CLOSE_NOT_FOUND, "The sale is gone");
	return new Response(null, { status: 101, webSocket: client });
}

/**
 * After a commit: the sale's new status (if it changed), then every changed item as
 * each viewer may see it, with the item's new version.
 *
 * @spec LIVE-broadcast — one diff per commit, versioned per item.
 * @spec LIVE-no-leak — projected per viewer; other buyers' entries never leave the engine.
 * @spec LIVE-access — when the sale goes back to draft, everyone but the seller is disconnected.
 */
export function broadcastCommit(hub: LiveHub, work: Work): void {
	const status = work.saleStatus;
	if (work.saleChange) {
		const sale = saleView(work.saleChange.next, work.now);
		hub.broadcast("sale", { sale });
		if (!visibleTo(status, "buyer")) {
			hub.closeWhere(
				(viewer: LiveViewer) => viewer.role !== "seller",
				LIVE_CLOSE_NOT_VISIBLE,
				"The sale isn't open to viewers any more",
			);
		}
	}
	const changed = work.changedItemIds().map((id) => {
		const slot = work.items.get(id)!;
		return { item: slot.after, version: slot.before.version + 1 };
	});
	if (changed.length === 0) return;
	const visibility = work.sale.settings.offerVisibility;
	hub.broadcast("items", (viewer) => ({
		items: changed.map(({ item, version }) =>
			liveItem(item, version, status, visibility, projectionViewer(viewer)),
		),
	}));
}
