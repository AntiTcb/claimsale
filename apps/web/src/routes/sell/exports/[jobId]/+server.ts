import { error } from "@sveltejs/kit";
import { db, imageStore } from "#lib/server/context.ts";
import { exportDownload } from "#lib/server/exports.ts";
import { requireSeller } from "#lib/server/sell.ts";
import type { RequestHandler } from "./$types";

/**
 * Downloads a finished export, for its seller, for 24 hours.
 *
 * @spec IO-export-expiry
 */
export const GET: RequestHandler = async (event) => {
	const seller = await requireSeller(event);
	const result = await exportDownload(db(), imageStore(), seller.id, event.params.jobId, Date.now());
	if (!result.ok) error(result.error.code === "expired" ? 410 : 404, result.error.message);
	return result.value;
};
