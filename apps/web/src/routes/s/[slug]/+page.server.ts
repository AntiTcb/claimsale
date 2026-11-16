import { fail, redirect } from "@sveltejs/kit";
import { cookieSecret, db } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { photosByItem } from "#lib/server/images.ts";
import { listItems } from "#lib/server/items.ts";
import {
	allowUnlockAttempt,
	unlockCookieName,
	unlockToken,
	verifySalePassword,
} from "#lib/server/sale-access.ts";
import { loadSaleForViewer, publicItem, saleBody, saleHeader } from "#lib/server/sale-view.ts";
import type { Actions, PageServerLoad } from "./$types";

/**
 * The read-only sale page. Claim and offer buttons arrive with the live grid (WS-H).
 *
 * @spec SM-2-visibility — locked private sales show only the title and seller.
 */
export const load: PageServerLoad = async (event) => {
	const { sale, access, isSeller } = await loadSaleForViewer(event, event.params.slug);
	const header = saleHeader(sale);
	if (access === "locked") {
		return {
			header,
			locked: {
				hasPassword: sale.hasPassword,
				allowlistEnabled: sale.allowlistEnabled,
				signedIn: event.locals.user !== null,
			},
			body: null,
			items: [],
			isSeller,
			serverNow: Date.now(),
		};
	}
	const rows = await listItems(db(), sale.id);
	const photos = await photosByItem(
		db(),
		rows.map((r) => r.id),
	);
	return {
		header,
		locked: null,
		body: saleBody(sale),
		items: rows.map((row) => {
			const first = photos.get(row.id)?.[0];
			return { ...publicItem(row), photoUrl: first ? `/api/images/${first.id}` : null };
		}),
		isSeller,
		serverNow: Date.now(),
	};
};

export const actions: Actions = {
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
