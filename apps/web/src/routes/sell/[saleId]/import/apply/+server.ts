import { json } from "@sveltejs/kit";
import { Result as EffectResult, Schema } from "effect";
import { db, imageStore } from "#lib/server/context.ts";
import { applyImportBatch, ImportBatchBody } from "#lib/server/import.ts";
import { jsonBody, sellerSaleForApi } from "#lib/server/seller-api.ts";
import type { RequestHandler } from "./$types";

const decode = Schema.decodeUnknownResult(ImportBatchBody);

/**
 * One batch of a confirmed item import (PLAN §3c.4). The browser sends the mapped
 * rows; the server validates and applies them again (IO-import-validate) through the
 * single import seam, `applyImportBatch`.
 */
export const POST: RequestHandler = async (event) => {
	const gate = await sellerSaleForApi(event);
	if (!gate.ok) return gate.response;
	const body = decode(await jsonBody(event.request));
	if (EffectResult.isFailure(body)) {
		return json({ code: "invalid_request", message: "That import batch isn't valid" }, { status: 400 });
	}
	const result = await applyImportBatch(db(), gate.seller, gate.sale.id, body.success, Date.now());
	if (!result.ok) {
		const status = result.error.code === "not_found" ? 404 : 409;
		return json({ code: result.error.code, message: result.error.message }, { status });
	}
	if (result.value.removedR2Keys.length > 0) await imageStore().delete([...result.value.removedR2Keys]);
	return json({ rows: result.value.rows, removed: result.value.removed });
};
