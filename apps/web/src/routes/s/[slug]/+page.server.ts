import { isTimestamped } from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { cookieSecret, db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { follow, isFollowing, unfollow } from "#lib/server/follows.ts";
import { findTimestampPhoto, photosByItem } from "#lib/server/images.ts";
import { listItems } from "#lib/server/items.ts";
import { liveSnapshotFor } from "#lib/server/live.ts";
import { fileReport } from "#lib/server/moderation.ts";
import { requireUser } from "#lib/server/sell.ts";
import {
	allowUnlockAttempt,
	unlockCookieName,
	unlockToken,
	verifySalePassword,
} from "#lib/server/sale-access.ts";
import { loadSaleForViewer, publicItem, saleBody, saleHeader } from "#lib/server/sale-view.ts";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The sale page and its live grid (WS-H): the items, plus the engine's projection of
 * them for this viewer (counts, visible offers, the viewer's own positions), which the
 * page then keeps current over the sale's WebSocket.
 *
 * @spec SM-2-visibility — locked private sales show only the title and seller.
 * @spec IMG-public-approved — buyers see approved photos only; the seller sees pending ones too.
 * @spec IMG-timestamp-required — the "Timestamped" badge and photo when the timestamp photo is approved.
 */
export const load: PageServerLoad = async (event) => {
	const { sale, access, isSeller } = await loadSaleForViewer(event, event.params.slug);
	const header = saleHeader(sale);
	const viewer = event.locals.user?.id ?? null;
	// D41: follow the seller from their sale (WS-L).
	const following = viewer !== null && !isSeller && (await isFollowing(db(), viewer, sale.sellerId));
	if (access === "locked") {
		return {
			header,
			locked: {
				hasPassword: sale.hasPassword,
				allowlistEnabled: sale.allowlistEnabled,
				signedIn: event.locals.user !== null,
			},
			body: null,
			timestampUrl: null,
			items: [],
			isSeller,
			serverNow: Date.now(),
			saleId: null,
			live: null,
			signedIn: event.locals.user !== null,
			following,
		};
	}
	const rows = await listItems(db(), sale.id);
	const [photos, timestamp, live] = await Promise.all([
		photosByItem(
			db(),
			rows.map((r) => r.id),
			isSeller ? "visible" : "approved",
		),
		findTimestampPhoto(db(), sale.id),
		liveSnapshotFor(env.ENGINE, sale.id, event.locals.user?.id ?? null),
	]);
	return {
		header,
		locked: null,
		body: saleBody(sale),
		timestampUrl: isTimestamped(timestamp?.status ?? null) ? `/api/images/${timestamp!.id}` : null,
		items: rows.map((row) => {
			const first = photos.get(row.id)?.[0];
			return { ...publicItem(row), photoUrl: first ? `/api/images/${first.id}` : null };
		}),
		isSeller,
		serverNow: live?.serverNow ?? Date.now(),
		saleId: sale.id,
		live,
		signedIn: event.locals.user !== null,
		following,
	};
};

export const actions: Actions = {
	/** D41: follow the sale's seller. */
	follow: async (event) => {
		const user = requireUser(event);
		const { sale } = await loadSaleForViewer(event, event.params.slug);
		const result = await follow(db(), user.id, sale.sellerId, Date.now());
		if (!result.ok) return fail(400, { followError: result.error.message });
		return { following: true };
	},
	unfollow: async (event) => {
		const user = requireUser(event);
		const { sale } = await loadSaleForViewer(event, event.params.slug);
		await unfollow(db(), user.id, sale.sellerId);
		return { following: false };
	},
	/**
	 * Report the sale to the admin queue; only a viewer who can see it can report it.
	 *
	 * @spec ADMIN-report-queue
	 */
	report: async (event) => {
		const user = requireUser(event);
		const { sale, access } = await loadSaleForViewer(event, event.params.slug);
		if (access !== "ok") return fail(403, { reportError: "Unlock the sale to report it" });
		const data = await event.request.formData();
		const result = await fileReport(
			db(),
			user.id,
			{
				targetKind: "sale",
				targetId: sale.id,
				reason: field(data, "reason"),
				details: field(data, "details"),
			},
			Date.now(),
		);
		if (!result.ok)
			return fail(result.error.code === "rate_limited" ? 429 : 400, { reportError: result.error.message });
		return { reported: true };
	},
	/** Unlocks a password-protected private sale for this browser session (D5). */
	unlock: async (event) => {
		const { sale, access } = await loadSaleForViewer(event, event.params.slug);
		if (access === "ok") redirect(303, `/s/${sale.slug}`);
		if (!sale.passwordHash)
			return fail(400, { message: "This sale has no password. Ask the seller for an invite." });
		const now = Date.now();
		if (!(await allowUnlockAttempt(db(), sale.id, event.getClientAddress(), now))) {
			return fail(429, { message: "Too many tries. Wait 15 minutes and try again." });
		}
		const password = field(await event.request.formData(), "password");
		if (!(await verifySalePassword(password, sale.passwordHash))) {
			return fail(400, { message: "That password isn't right." });
		}
		event.cookies.set(
			unlockCookieName(sale.id),
			await unlockToken(cookieSecret(), sale.id, sale.passwordHash),
			{
				path: "/",
				httpOnly: true,
				sameSite: "lax",
				secure: event.url.protocol === "https:",
			},
		);
		return redirect(303, `/s/${sale.slug}`);
	},
};
