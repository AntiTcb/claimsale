import { FREE_ITEM_CAP, photoCap } from "@claimsale/core";
import { fail } from "@sveltejs/kit";
import { priceInputValue, validateItem, type ItemInput } from "#lib/listing-input.ts";
import { db, imageStore } from "#lib/server/context.ts";
import { field } from "#lib/server/forms.ts";
import { photosByItem } from "#lib/server/images.ts";
import {
	addItem,
	deleteItem,
	itemsWithEntries,
	listItems,
	reorderItems,
	updateItem,
} from "#lib/server/items.ts";
import { requireOwnSale, requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Step 3 of the wizard and the bulk editor: fast entry, inline edits, reorder, photos. */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const sale = await requireOwnSale(seller.id, event.params.saleId);
	const rows = await listItems(db(), sale.id);
	const ids = rows.map((r) => r.id);
	const [photos, withEntries] = await Promise.all([
		photosByItem(db(), ids, "all"),
		itemsWithEntries(db(), ids),
	]);
	return {
		wizard: event.url.searchParams.get("wizard") === "1",
		canAdd: sale.status === "draft" || sale.status === "scheduled",
		canEdit: sale.status === "draft" || sale.status === "scheduled" || sale.status === "live",
		itemCap: seller.tier === "free" ? FREE_ITEM_CAP : null,
		photoCap: photoCap(seller.tier),
		items: rows.map((item) => ({
			id: item.id,
			title: item.title,
			price: priceInputValue(item.priceCents),
			quantity: String(item.quantity),
			gameId: item.gameId,
			kind: item.kind,
			condition: item.condition ?? "",
			attributes: Object.keys(item.attributes).length > 0 ? JSON.stringify(item.attributes) : "",
			/** SM-2-lock-price-qty: shown read-only once the item has entries. */
			locked: withEntries.has(item.id),
			photos: (photos.get(item.id) ?? []).map((p) => ({
				id: p.id,
				url: `/api/images/${p.id}`,
				status: p.status,
				...(p.rejection ? { rejection: p.rejection } : {}),
			})),
		})),
	};
};

function readItem(data: FormData): ItemInput {
	return {
		title: field(data, "title"),
		price: field(data, "price"),
		quantity: field(data, "quantity"),
		gameId: field(data, "gameId"),
		kind: field(data, "kind"),
		condition: field(data, "condition"),
		attributes: field(data, "attributes"),
	};
}

export const actions: Actions = {
	/** @spec SM-2-free-item-cap */
	add: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const values = readItem(await event.request.formData());
		const valid = validateItem(values);
		if (!valid.ok) return fail(400, { action: "add" as const, values, errors: valid.errors });
		const added = await addItem(db(), seller, sale.id, valid.value, Date.now());
		if (!added.ok)
			return fail(400, { action: "add" as const, values, errors: { form: added.error.message } });
		return {
			action: "add" as const,
			added: added.value.id,
			values: { ...values, title: "", price: "", quantity: "", attributes: "" },
		};
	},

	/** @spec SM-2-lock-price-qty */
	update: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const data = await event.request.formData();
		const itemId = field(data, "itemId");
		const values = readItem(data);
		const valid = validateItem(values);
		if (!valid.ok) return fail(400, { action: "update" as const, itemId, values, errors: valid.errors });
		const updated = await updateItem(db(), seller.id, sale.id, itemId, valid.value, Date.now());
		if (!updated.ok)
			return fail(400, {
				action: "update" as const,
				itemId,
				values,
				errors: { form: updated.error.message },
			});
		return { action: "update" as const, itemId, saved: true };
	},

	delete: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const itemId = field(await event.request.formData(), "itemId");
		const deleted = await deleteItem(db(), seller.id, sale.id, itemId);
		if (!deleted.ok)
			return fail(400, { action: "delete" as const, itemId, errors: { form: deleted.error.message } });
		if (deleted.value.r2Keys.length > 0) await imageStore().delete(deleted.value.r2Keys);
		return { action: "delete" as const, itemId };
	},

	reorder: async (event) => {
		const seller = await requireSeller(event);
		const sale = await requireOwnSale(seller.id, event.params.saleId);
		const order = field(await event.request.formData(), "order")
			.split(",")
			.filter(Boolean);
		const result = await reorderItems(db(), seller.id, sale.id, order, Date.now());
		if (!result.ok) return fail(400, { action: "reorder" as const, errors: { form: result.error.message } });
		return { action: "reorder" as const, saved: true };
	},
};
