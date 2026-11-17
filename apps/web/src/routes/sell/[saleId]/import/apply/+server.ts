import { ImportBatchBody } from "@claimsale/core";
import { json } from "@sveltejs/kit";
import { Result as EffectResult, Schema } from "effect";
import { engineRpc, imageStore } from "#lib/server/context.ts";
import { jsonBody, sellerSaleForApi } from "#lib/server/seller-api.ts";
import type { RequestHandler } from "./$types";

const decode = Schema.decodeUnknownResult(ImportBatchBody);

const STATUS: Readonly<Record<string, number>> = {
	not_found: 404,
	sale_not_importable: 409,
	import_conflict: 409,
	conflict: 409,
};

/**
 * One batch of a confirmed item import (PLAN §3c.4). The engine applies it under the
 * sale's lock (`applyImportBatch` RPC), validating every row again (IO-import-validate);
 * this route checks the seller, decodes the batch and deletes the photos of removed items.
 */
export const POST: RequestHandler = async (event) => {
	const gate = await sellerSaleForApi(event);
	if (!gate.ok) return gate.response;
	const body = decode(await jsonBody(event.request));
	if (EffectResult.isFailure(body)) {
		return json({ code: "invalid_request", message: "That import batch isn't valid" }, { status: 400 });
	}
	const result = await engineRpc().applyImportBatch({
		saleId: gate.sale.id,
		sellerId: gate.seller.id,
		...body.success,
	});
	if (!result.ok) {
		return json({ code: "unavailable", message: "The import stopped. Try again." }, { status: 503 });
	}
	const outcome = result.value;
	if (!outcome.ok) {
		return json(
			{ code: outcome.error.code, message: outcome.error.message },
			{ status: STATUS[outcome.error.code] ?? 400 },
		);
	}
	if (outcome.value.removedR2Keys.length > 0) await imageStore().delete([...outcome.value.removedR2Keys]);
	return json({ rows: outcome.value.rows, removed: outcome.value.removed });
};
