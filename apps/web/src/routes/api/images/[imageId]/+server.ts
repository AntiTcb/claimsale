import { imageCacheControl } from "@claimsale/core";
import { error, json } from "@sveltejs/kit";
import { cookieSecret, db, imageStore } from "#lib/server/context.ts";
import { deleteItemPhoto, findImageWithSale } from "#lib/server/images.ts";
import { accessFor, unlockCookieName } from "#lib/server/sale-access.ts";
import { findSaleById } from "#lib/server/sales.ts";
import type { RequestHandler } from "./$types";

/**
 * Serves a seller photo after the same access check as its sale page.
 *
 * @spec SM-2-private-images — R2 objects are never public; drafts and private sales
 * are `private, no-store`, so a copied URL stops working once access ends.
 * @spec SM-2-visibility
 */
export const GET: RequestHandler = async ({ params, locals, cookies }) => {
	const image = await findImageWithSale(db(), params.imageId);
	if (!image) error(404, "Not found");
	const isSeller = locals.user?.id === image.sale.sellerId;
	if (image.status === "rejected" && !isSeller) error(404, "Not found");
	if (!isSeller) {
		const sale = await findSaleById(db(), image.sale.id);
		if (!sale) error(404, "Not found");
		const access = await accessFor(db(), cookieSecret(), sale, {
			user: locals.user,
			unlockCookie: cookies.get(unlockCookieName(sale.id)),
		});
		if (access !== "ok") error(404, "Not found");
	}
	const object = await imageStore().get(image.r2Key);
	if (!object) error(404, "Not found");
	return new Response(object.body, {
		headers: {
			"content-type": image.contentType,
			"cache-control": isSeller ? "private, no-store" : imageCacheControl(image.sale),
			"x-content-type-options": "nosniff",
		},
	});
};

/** The seller removes one of their photos. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) return json({ message: "Sign in first" }, { status: 401 });
	const image = await findImageWithSale(db(), params.imageId);
	if (!image || image.sale.sellerId !== locals.user.id)
		return json({ message: "No such photo" }, { status: 404 });
	const result = await deleteItemPhoto(db(), imageStore(), locals.user.id, image.sale.id, params.imageId);
	return result.ok
		? new Response(null, { status: 204 })
		: json({ message: result.error.message }, { status: 404 });
};
