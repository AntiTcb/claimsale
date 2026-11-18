import { isExportKind } from "@claimsale/core";
import { fail } from "@sveltejs/kit";
import { db, engineRpc } from "#lib/server/context.ts";
import { listExports } from "#lib/server/exports.ts";
import { field } from "#lib/server/forms.ts";
import { listSellerSales } from "#lib/server/sales.ts";
import { requireSeller } from "#lib/server/sell.ts";
import type { Actions, PageServerLoad } from "./$types";

/** Export jobs and their 24h download links (PLAN §3c.2, IO-export-expiry). */
export const load: PageServerLoad = async (event) => {
	const seller = await requireSeller(event);
	const [jobs, sales] = await Promise.all([
		listExports(db(), seller.id, Date.now()),
		listSellerSales(db(), seller.id),
	]);
	return {
		jobs,
		sales: sales.map((s) => ({ id: s.id, title: s.title })),
		selected: event.url.searchParams.get("sale") ?? "",
	};
};

export const actions: Actions = {
	/** @spec IO-export-expiry — the engine records the job and its audit row, then builds it on its queue. */
	default: async (event) => {
		const seller = await requireSeller(event);
		const data = await event.request.formData();
		const saleId = field(data, "saleId");
		const kind = field(data, "kind");
		if (saleId === "" || !isExportKind(kind))
			return fail(400, { message: "Choose a sale and what to export" });
		const result = await engineRpc().requestExport({ saleId, sellerId: seller.id, kind });
		if (!result.ok)
			return fail(503, { message: "Exports are unavailable right now. Try again in a moment." });
		if (!result.value.ok) return fail(400, { message: result.value.error.message });
		return { requested: result.value.value.jobId };
	},
};
