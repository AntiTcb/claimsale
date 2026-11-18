import { json } from "@sveltejs/kit";
import { Result as EffectResult, Schema } from "effect";
import { invoiceEngine } from "#lib/server/context.ts";
import { jsonBody, sellerSaleForApi } from "#lib/server/seller-api.ts";
import type { RequestHandler } from "./$types";

/** The most rows one request applies; the engine takes the same per call. */
const TRACKING_APPLY_MAX = 200;

const Body = Schema.Struct({
	rows: Schema.Array(
		Schema.Struct({
			row: Schema.Int.check(Schema.isGreaterThan(0)),
			invoiceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
			carrier: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
			number: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
			replace: Schema.Boolean,
		}),
	).check(Schema.isMaxLength(TRACKING_APPLY_MAX)),
});
const decode = Schema.decodeUnknownResult(Body);

/**
 * Applies matched tracking rows through the sale engine, which moves `paid` invoices to
 * `shipped` and rejects the rest with a reason (IO-tracking-transition); replacements
 * need the row's `replace` confirmation and are logged (IO-tracking-replace).
 */
export const POST: RequestHandler = async (event) => {
	const gate = await sellerSaleForApi(event);
	if (!gate.ok) return gate.response;
	const body = decode(await jsonBody(event.request));
	if (EffectResult.isFailure(body)) {
		return json({ code: "invalid_request", message: "Those tracking rows aren't valid" }, { status: 400 });
	}
	const result = await invoiceEngine().applyTracking(gate.sale.id, gate.seller.id, body.success.rows);
	if (!result.ok) {
		const status = result.error.code === "engine_unavailable" ? 503 : 400;
		return json({ code: result.error.code, message: result.error.message }, { status });
	}
	return json({ rows: result.value.rows });
};
