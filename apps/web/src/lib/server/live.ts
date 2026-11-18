import { LIVE_VIEWER_HEADER, type LiveSnapshot } from "@claimsale/core";
import type { Db } from "@claimsale/db";
import type { RpcResult } from "@claimsale/engine";
import { accessFor, type AccessViewer } from "./sale-access.ts";
import { findSaleById } from "./sales.ts";

/**
 * The live sale page (WS-H): `GET /api/sales/[saleId]/live` upgrades to a WebSocket on
 * the sale's SaleEngine, and the page's first render reads the same projection over RPC.
 * The web Worker owns who may connect; the engine owns what each viewer is sent.
 */

export type LiveBinding = Pick<Env["ENGINE"], "fetch" | "liveSnapshot">;

export type LiveUpgrade =
	| { readonly kind: "refuse"; readonly status: number; readonly message: string }
	/** Forward this request to the engine and hand its socket to the browser. */
	| { readonly kind: "forward"; readonly request: Request };

/**
 * Decides whether this request may open the sale's live socket.
 *
 * @spec LIVE-access — the same access as the sale page (SM-2-visibility, private sales
 * included), only from the site's own pages (a cross-site page can't ride the session
 * cookie), and the engine learns the viewer from the session, never from the browser.
 */
export async function liveUpgrade(
	deps: { readonly db: Db; readonly secret: string },
	viewer: AccessViewer,
	saleId: string,
	request: Pick<Request, "headers">,
	origin: string,
): Promise<LiveUpgrade> {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return { kind: "refuse", status: 426, message: "Expected a WebSocket upgrade" };
	}
	const from = request.headers.get("origin");
	if (from !== null && from !== origin) return { kind: "refuse", status: 403, message: "Wrong origin" };
	const sale = await findSaleById(deps.db, saleId);
	if (!sale || (await accessFor(deps.db, deps.secret, sale, viewer)) !== "ok") {
		return { kind: "refuse", status: 404, message: "No such sale" };
	}
	return {
		kind: "forward",
		request: new Request(`https://engine/live/${encodeURIComponent(saleId)}`, {
			headers: {
				upgrade: "websocket",
				...(viewer.user ? { [LIVE_VIEWER_HEADER]: viewer.user.id } : {}),
			},
		}),
	};
}

/**
 * Every item as this viewer may see it, for the page's first render. Null when the
 * engine can't answer (e.g. `pnpm dev:ui` without it): the page still renders, without
 * live counts.
 */
export async function liveSnapshotFor(
	engine: Pick<LiveBinding, "liveSnapshot"> | undefined,
	saleId: string,
	viewerId: string | null,
): Promise<LiveSnapshot | null> {
	if (!engine) return null;
	try {
		const result = (await engine.liveSnapshot({ saleId, viewerId })) as RpcResult<LiveSnapshot | null>;
		return result.ok ? result.value : null;
	} catch {
		return null;
	}
}
