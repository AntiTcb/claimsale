import { EXPORT_LINK_TTL } from "@claimsale/core";
import { createDb, type Db } from "@claimsale/db";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, memoryStore } from "../../../test/fixtures.ts";
import { exportDownload, listExports } from "./exports.ts";

let d1: D1Database;
let db: Db;
const NOW = Date.UTC(2026, 10, 20, 12);

async function job(
	id: string,
	options: {
		kind?: string;
		layout?: string | null;
		status?: string;
		finishedAt?: number | null;
		seller?: string;
	} = {},
) {
	const finishedAt = options.finishedAt === undefined ? NOW - 1000 : options.finishedAt;
	await d1
		.prepare(
			`INSERT INTO io_jobs (id, seller_id, sale_id, kind, status, format, layout, result_key, row_count, created_at, finished_at, expires_at)
			VALUES (?1, ?2, 's1', ?3, ?4, 'csv', ?5, ?6, 3, ?7, ?8, ?9)`,
		)
		.bind(
			id,
			options.seller ?? "seller",
			options.kind ?? "export_orders",
			options.status ?? "done",
			options.layout ?? null,
			`exports/seller/${id}.csv`,
			NOW - 2000,
			finishedAt,
			finishedAt === null ? null : finishedAt + EXPORT_LINK_TTL,
		)
		.run();
}

beforeEach(async () => {
	d1 = testD1();
	db = createDb(d1);
	await addUser(db, "seller");
	await addUser(db, "other");
	await d1
		.prepare(
			"INSERT INTO sales (id, seller_id, slug, title, created_at, updated_at) VALUES ('s1', 'seller', 'weekend-ygo', 'Weekend YGO', 1, 1)",
		)
		.run();
});

describe("exports", () => {
	it("lists the seller's exports with their state [IO-export-expiry]", async () => {
		await job("ready");
		await job("old", { finishedAt: NOW - EXPORT_LINK_TTL - 1 });
		await job("running", { status: "applying", finishedAt: null });
		await job("labels", { kind: "export_shipping", layout: "generic" });
		await job("import", { kind: "item_import" });
		await job("theirs", { seller: "other" });
		const jobs = await listExports(db, "seller", NOW);
		expect(Object.fromEntries(jobs.map((j) => [j.id, [j.kind, j.status]]))).toEqual({
			ready: ["orders", "ready"],
			old: ["orders", "expired"],
			running: ["orders", "running"],
			labels: ["shipping_generic", "ready"],
		});
		expect(jobs.find((j) => j.id === "ready")!.saleTitle).toBe("Weekend YGO");
	});

	it("serves the file to its seller only, as a private attachment, until the link expires [IO-export-expiry]", async () => {
		const store = memoryStore();
		await store.put("exports/seller/ready.csv", new TextEncoder().encode("a,b\r\n"));
		await job("ready");
		const download = await exportDownload(db, store, "seller", "ready", NOW);
		if (!download.ok) throw new Error(download.error.message);
		expect(download.value.headers.get("content-disposition")).toBe(
			'attachment; filename="claimsale-orders-weekend-ygo-2026-11-20.csv"',
		);
		expect(download.value.headers.get("cache-control")).toBe("private, no-store");
		expect(await download.value.text()).toBe("a,b\r\n");

		expect(await exportDownload(db, store, "other", "ready", NOW)).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(await exportDownload(db, store, "seller", "ready", NOW - 1000 + EXPORT_LINK_TTL)).toMatchObject({
			ok: false,
			error: { code: "expired" },
		});
	});

	it("a running or failed export has no download [IO-export-expiry]", async () => {
		const store = memoryStore();
		await job("running", { status: "applying", finishedAt: null });
		expect((await exportDownload(db, store, "seller", "running", NOW)).ok).toBe(false);
		await job("gone");
		// The cron already deleted the file.
		expect(await exportDownload(db, store, "seller", "gone", NOW)).toMatchObject({
			error: { code: "expired" },
		});
	});
});
