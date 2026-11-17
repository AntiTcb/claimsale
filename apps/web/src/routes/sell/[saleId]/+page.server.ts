import {
	DAY,
	FREE_ACTIVE_SALE_CAP,
	FREE_ITEM_CAP,
	MAX_LIVE_DURATION,
	needsTimestampPhoto,
} from "@claimsale/core";
import { fail, redirect } from "@sveltejs/kit";
import { parseLocalDateTime } from "#lib/listing-input.ts";
import { db, engine } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { findTimestampPhoto, publishPhotoState } from "#lib/server/images.ts";
import { countItems } from "#lib/server/items.ts";
import {
	countActiveSales,
	deleteDraft,
	findSaleById,
	readAllowlist,
	setPrivateAccess,
	updateDetails,
} from "#lib/server/sales.ts";
import { readDetailsForm, requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Sale overview: details, private access, and publishing (STATE_MACHINES §2). */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const saleId = event.params.saleId;
	const [itemCount, photos, timestamp, active, access, allowlist] = await Promise.all([
		countItems(db(), saleId),
		publishPhotoState(db(), saleId, seller.id),
		findTimestampPhoto(db(), saleId),
		countActiveSales(db(), seller.id, saleId),
		findSaleById(db(), saleId),
		readAllowlist(db(), saleId),
	]);
	return {
		itemCount,
		missingPhotos: photos.items.filter((i) => !i.photos.some((s) => s !== "rejected")).length,
		checkingPhotos: photos.items.filter((i) => !i.photos.includes("approved") && i.photos.includes("pending"))
			.length,
		heldPhotos: photos.items.filter(
			(i) => !i.photos.includes("approved") && !i.photos.includes("pending") && i.photos.includes("review"),
		).length,
		timestamp: {
			required: needsTimestampPhoto(photos.completedSales),
			photo: timestamp ?? null,
			handle: event.locals.user?.handle ?? "",
		},
		activeOtherSales: active,
		hasPassword: access?.hasPassword ?? false,
		allowlist: allowlist.join("\n"),
		caps: { sales: FREE_ACTIVE_SALE_CAP, items: FREE_ITEM_CAP, maxLiveDays: MAX_LIVE_DURATION / DAY },
	};
};

export const actions: Actions = {
	details: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const current = await findSaleById(db(), sale.id);
		const form = await readDetailsForm(await event.request.formData(), {
			hasPassword: current?.hasPassword ?? false,
		});
		if (!form.ok) return fail(400, { action: "details" as const, values: form.values, errors: form.errors });
		const now = Date.now();
		const updated = await updateDetails(db(), seller, sale.id, form.details, now);
		if (!updated.ok) {
			return fail(400, {
				action: "details" as const,
				values: form.values,
				errors: { form: updated.error.message },
			});
		}
		if (form.access) {
			const saved = await setPrivateAccess(db(), sale.id, form.access, now);
			if (!saved.ok) {
				return fail(400, {
					action: "details" as const,
					values: form.values,
					errors: { password: saved.error.message },
				});
			}
		}
		return { action: "details" as const, saved: true };
	},

	/**
	 * Schedules the sale or puts it live now, through the engine.
	 *
	 * @spec SM-2-publish-scheduled
	 * @spec SM-2-publish-now
	 */
	publish: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const data = await event.request.formData();
		const now = Date.now();
		const when = field(data, "when");
		const days = Number(field(data, "duration"));
		const values = { when, liveAt: field(data, "liveAt"), duration: field(data, "duration") };
		if (!Number.isInteger(days) || days < 1 || days > 14) {
			return fail(400, {
				action: "publish" as const,
				values,
				message: "Choose how long the sale runs (1–14 days)",
			});
		}
		let liveAt: number | null = null;
		if (when === "schedule") {
			liveAt = parseLocalDateTime(values.liveAt, Number(field(data, "tzOffset")) || 0);
			if (liveAt === null)
				return fail(400, { action: "publish" as const, values, message: "Choose when the sale goes live" });
		}
		const result = await engine().publish({
			saleId: sale.id,
			sellerId: seller.id,
			liveAt,
			closesAt: (liveAt ?? now) + days * DAY,
		});
		if (!result.ok) return fail(400, { action: "publish" as const, values, message: result.error.message });
		return { action: "publish" as const, published: result.value.status };
	},

	unpublish: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const result = await engine().unpublish({ saleId: sale.id, sellerId: seller.id });
		if (!result.ok) return fail(400, { action: "unpublish" as const, message: result.error.message });
		return { action: "unpublish" as const, done: true };
	},

	delete: async (event) => {
		const seller = await requireSeller(event);
		const result = await deleteDraft(db(), seller.id, event.params.saleId, Date.now());
		if (!result.ok) return fail(400, { action: "delete" as const, message: result.error.message });
		return redirect(303, "/sell");
	},
};
