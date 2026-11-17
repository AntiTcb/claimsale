import {
	exportDownloadable,
	exportFileName,
	reject,
	type ExportKind,
	type Millis,
	type Rejection,
	type Result,
} from "@claimsale/core";
import { and, desc, eq, inArray, type Db } from "@claimsale/db";
import { ioJobs, sales } from "@claimsale/db/schema";
import type { ImageStore } from "./images.ts";

/**
 * Seller exports (PLAN §3c.2, /sell/exports). The engine builds each file on its queue
 * and stores it in R2; this module lists the seller's jobs and serves a finished file to
 * its seller only, for 24 hours (IO-export-expiry).
 */

const EXPORT_JOB_KINDS = ["export_items", "export_orders", "export_shipping"] as const;

export interface ExportJobView {
	readonly id: string;
	readonly saleId: string | null;
	readonly saleTitle: string | null;
	readonly kind: ExportKind;
	readonly status: "running" | "ready" | "failed" | "expired";
	readonly rowCount: number;
	readonly createdAt: Millis;
	readonly expiresAt: Millis | null;
}

const kindOf = (kind: string, layout: string | null): ExportKind =>
	kind === "export_items"
		? "items"
		: kind === "export_orders"
			? "orders"
			: layout === "generic"
				? "shipping_generic"
				: "pirate_ship";

function statusOf(job: { status: string; expiresAt: Millis | null }, now: Millis): ExportJobView["status"] {
	if (job.status === "applying" || job.status === "parsed") return "running";
	if (job.status === "failed") return "failed";
	return exportDownloadable(job, now) ? "ready" : "expired";
}

/** The seller's recent exports, newest first. */
export async function listExports(db: Db, sellerId: string, now: Millis): Promise<ExportJobView[]> {
	const rows = await db
		.select({ job: ioJobs, saleTitle: sales.title })
		.from(ioJobs)
		.leftJoin(sales, eq(sales.id, ioJobs.saleId))
		.where(and(eq(ioJobs.sellerId, sellerId), inArray(ioJobs.kind, EXPORT_JOB_KINDS)))
		.orderBy(desc(ioJobs.createdAt))
		.limit(50)
		.all();
	return rows.map(({ job, saleTitle }) => ({
		id: job.id,
		saleId: job.saleId,
		saleTitle,
		kind: kindOf(job.kind, job.layout),
		status: statusOf(job, now),
		rowCount: job.rowCount,
		createdAt: job.createdAt,
		expiresAt: job.expiresAt,
	}));
}

/**
 * A finished export's file, for its seller only.
 *
 * @spec IO-export-expiry — the link stops working 24 hours after the file was built.
 */
export async function exportDownload(
	db: Db,
	store: Pick<ImageStore, "get">,
	sellerId: string,
	jobId: string,
	now: Millis,
): Promise<Result<Response, Rejection<"not_found" | "expired">>> {
	const row = await db
		.select({ job: ioJobs, slug: sales.slug })
		.from(ioJobs)
		.leftJoin(sales, eq(sales.id, ioJobs.saleId))
		.where(and(eq(ioJobs.id, jobId), eq(ioJobs.sellerId, sellerId), inArray(ioJobs.kind, EXPORT_JOB_KINDS)))
		.get();
	if (!row) return reject("not_found", "No such export");
	if (!exportDownloadable(row.job, now) || row.job.resultKey === null)
		return reject("expired", "This export link has expired. Request a new export.");
	const object = await store.get(row.job.resultKey);
	if (!object) return reject("expired", "This export link has expired. Request a new export.");
	const name = exportFileName(
		kindOf(row.job.kind, row.job.layout),
		row.slug ?? "sale",
		row.job.finishedAt ?? now,
	);
	return {
		ok: true,
		value: new Response(object.body, {
			headers: {
				"content-type": "text/csv; charset=utf-8",
				"content-disposition": `attachment; filename="${name}"`,
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			},
		}),
	};
}
