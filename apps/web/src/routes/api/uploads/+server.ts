import { json } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { db, imageStore } from "#lib/server/context.ts";
import { entitlements } from "#lib/server/entitlements.ts";
import { MAX_BYTES } from "#lib/server/image-sanitize.ts";
import { addItemPhoto, setTimestampPhoto } from "#lib/server/images.ts";
import { requestPhotoCheck } from "#lib/server/photo-checks.ts";
import { runExit } from "#lib/server/runtime.ts";
import { sellerReadiness } from "#lib/server/seller.ts";
import type { RequestHandler } from "./$types";

/**
 * Receives one photo, already resized and re-encoded by the browser (PLAN §5 "Images",
 * step 2 "upload through a Worker endpoint"). The body is the image itself. It's
 * sanitized again, stored in R2 as `pending`, and its duplicate check is queued in the
 * engine (photo authenticity, D63).
 *
 * `?sale=&item=` is an item photo; `?sale=&kind=timestamp` the sale's timestamp photo (D66).
 */
export const POST: RequestHandler = async ({ request, url, locals }) => {
	if (!locals.user) return json({ message: "Sign in to upload photos" }, { status: 401 });
	const saleId = url.searchParams.get("sale") ?? "";
	const itemId = url.searchParams.get("item") ?? "";
	const timestamp = url.searchParams.get("kind") === "timestamp";
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BYTES) return json({ message: "That photo is larger than 5 MB" }, { status: 413 });
	const body = new Uint8Array(await request.arrayBuffer());
	const now = Date.now();
	const tier = (await entitlements(db(), locals.user.id, now)).seller;
	// D55: the same seller gate as the /sell pages (an API can't redirect, so 403).
	if (sellerReadiness(locals.user).length > 0) {
		return json({ message: "Finish the seller requirements first" }, { status: 403 });
	}
	const result = timestamp
		? await setTimestampPhoto(db(), imageStore(), locals.user.id, saleId, body, now)
		: await addItemPhoto(db(), imageStore(), { id: locals.user.id, tier }, { saleId, itemId }, body, now);
	if (!result.ok) {
		const status =
			result.error.code === "not_found"
				? 404
				: result.error.code === "too_large"
					? 413
					: result.error.code === "photo_cap_reached"
						? 409
						: 400;
		return json({ code: result.error.code, message: result.error.message }, { status });
	}
	await runExit("web.photos.request_check", requestPhotoCheck(env.ENGINE, result.value.id));
	return json(
		{ id: result.value.id, url: `/api/images/${result.value.id}`, status: result.value.status },
		{ status: 201 },
	);
};
