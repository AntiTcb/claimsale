/**
 * Seller exports (WS-J): the request (job + audit row + queue message), the queue
 * consumer writing the CSV to R2, privacy of the orders file, and the 24h expiry.
 */
import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expireExports, exportKey, runExportJob } from "../src/exports/index.ts";
import { handleQueue } from "../src/handlers.ts";
import { Mailer } from "../src/mailer.ts";
import {
	addAddress,
	addressOf,
	addUser,
	auditOf,
	claim,
	DAY,
	db,
	engine,
	invoicesOf,
	makeSale,
	value,
} from "./sale-fixtures.ts";

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	quiet = [vi.spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

const deps = () => ({ db: env.DB, bucket: env.IMAGES });
const SHIPPING = [{ id: "ground", label: "Ground Advantage", priceCents: 550, tracked: true }];

let phones = 0;

/** A closed sale with one paid invoice whose buyer has an email and an address. */
async function paidSale() {
	const sale = await makeSale({
		items: [{ priceCents: 1500, title: '=HYPERLINK("x") Charizard' }],
		shipping: SHIPPING,
		closesAt: Date.now() + 10 * DAY,
	});
	const buyer = await addUser();
	await db
		.prepare("UPDATE users SET handle = ?1, phone_e164 = ?2 WHERE id = ?3")
		.bind(`h${buyer}`.slice(0, 20), `+1555${String(phones++).padStart(7, "0")}`, buyer)
		.run();
	await addAddress(buyer);
	await claim(sale, buyer);
	value(await engine.closeSale({ saleId: sale.saleId, sellerId: sale.sellerId }));
	const invoiceId = (await invoicesOf(sale.saleId))[0]!["id"] as string;
	const seller = { saleId: sale.saleId, invoiceId, sellerId: sale.sellerId };
	value(await engine.sendInvoice(seller));
	value(
		await engine.markInvoicePaid({
			saleId: sale.saleId,
			invoiceId,
			buyerId: buyer,
			addressId: addressOf(buyer),
			shippingOptionId: "ground",
			paymentRef: null,
		}),
	);
	value(await engine.confirmInvoicePaid(seller));
	return { sale, buyer, invoiceId };
}

const job = (jobId: string) => db.prepare("SELECT * FROM io_jobs WHERE id = ?1").bind(jobId).first();

async function requested(
	saleId: string,
	sellerId: string,
	kind: "items" | "orders" | "pirate_ship" | "shipping_generic",
) {
	const result = await engine.requestExport({ saleId, sellerId, kind });
	if (!result.ok || !result.value.ok) throw new Error(`export not requested: ${JSON.stringify(result)}`);
	return result.value.value.jobId;
}

async function built(jobId: string) {
	await Effect.runPromise(runExportJob(deps(), jobId, Date.now()));
	const row = (await job(jobId))!;
	const object = await env.IMAGES.get(row["result_key"] as string);
	return { row, text: (await object!.text()).replace(/^﻿/, "") };
}

describe("0009 migration (expand/contract)", () => {
	it("only adds two nullable columns", () => {
		const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009_"));
		const statements = migration!.queries.map((q) => q.replace(/^--.*$/gm, "").trim()).filter(Boolean);
		expect(statements.map((s) => s.replace(/;$/, ""))).toEqual([
			"ALTER TABLE `invoices` ADD `shipping_option_label` text",
			"ALTER TABLE `io_jobs` ADD `layout` text",
		]);
	});

	it("applies on top of the previous schema, keeping its invoices and jobs", async () => {
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("migration-check-0009"));
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			for (const migration of env.TEST_MIGRATIONS.filter((m) => m.name < "0009_"))
				for (const query of migration.queries) sql.exec(query);
			sql.exec(
				"INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@example.test', 'A', 1, 1)",
			);
			sql.exec(
				"INSERT INTO sales (id, seller_id, slug, title, created_at, updated_at) VALUES ('s1', 'u1', 's1', 'S', 1, 1)",
			);
			sql.exec(
				"INSERT INTO invoices (id, sale_id, buyer_id, seller_id, created_at, updated_at) VALUES ('i1', 's1', 'u1', 'u1', 1, 1)",
			);
			sql.exec(
				"INSERT INTO io_jobs (id, seller_id, kind, status, created_at) VALUES ('j1', 'u1', 'export_orders', 'done', 1)",
			);
			for (const migration of env.TEST_MIGRATIONS.filter((m) => m.name >= "0009_"))
				for (const query of migration.queries) sql.exec(query);
			expect(sql.exec("SELECT id, shipping_option_label FROM invoices").toArray()).toEqual([
				{ id: "i1", shipping_option_label: null },
			]);
			expect(sql.exec("SELECT id, layout FROM io_jobs").toArray()).toEqual([{ id: "j1", layout: null }]);
		});
	});
});

describe("exports", () => {
	it("a request records the job and an audit row, and the consumer builds the file [IO-export-expiry]", async () => {
		const { sale } = await paidSale();
		const jobId = await requested(sale.saleId, sale.sellerId, "orders");
		expect(await job(jobId)).toMatchObject({
			status: "applying",
			kind: "export_orders",
			seller_id: sale.sellerId,
			sale_id: sale.saleId,
		});
		const audit = (await auditOf(sale.saleId)).find((a) => a.action === "export_requested");
		expect(audit).toMatchObject({ actor_id: sale.sellerId, data: { input: { jobId, kind: "orders" } } });

		const batch = createMessageBatch("claimsale-notifications-local", [
			{ id: "x0", timestamp: new Date(), attempts: 1, body: { kind: "export_job", job_id: jobId } },
		]);
		const ctx = createExecutionContext();
		const noMail = Layer.succeed(Mailer, { send: () => Effect.die(new Error("no mail in export tests")) });
		await Effect.runPromise(
			handleQueue(batch, { probeRecipient: undefined, exports: deps() }).pipe(Effect.provide(noMail)),
		);
		expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["x0"]);
		const row = (await job(jobId))!;
		expect(row).toMatchObject({ status: "done", row_count: 1, result_key: exportKey(sale.sellerId, jobId) });
		expect((row["expires_at"] as number) - (row["finished_at"] as number)).toBe(DAY);
	});

	it("the orders file has the handle, name and address but never email or phone, and escapes formulas [IO-export-privacy] [IO-export-formula-escape]", async () => {
		const { sale, buyer } = await paidSale();
		const { text } = await built(await requested(sale.saleId, sale.sellerId, "orders"));
		expect(text).toContain(`h${buyer}`.slice(0, 20));
		expect(text).toContain("1 Route 1");
		expect(text).toContain("Ground Advantage");
		expect(text).toContain("CS-");
		expect(text).not.toContain("@example.test");
		expect(text).not.toContain("+1555");
		expect(text).toContain(`"'=HYPERLINK(""x"") Charizard"`);
	});

	it("the Pirate Ship file lists paid orders by invoice number, and the items file the sale's items [IO-export-privacy]", async () => {
		const { sale } = await paidSale();
		const pirate = await built(await requested(sale.saleId, sale.sellerId, "pirate_ship"));
		expect(pirate.text.split("\r\n")[0]).toContain("Order ID");
		expect(pirate.text).toMatch(/\r\nCS-\d+,Ash Ketchum,/);
		const items = await built(await requested(sale.saleId, sale.sellerId, "items"));
		expect(items.row).toMatchObject({ kind: "export_items", row_count: 1 });
		expect(items.text.split("\r\n")[0]).toContain("item_id");
	});

	it("only the sale's seller can export it [IO-export-privacy]", async () => {
		const { sale, buyer } = await paidSale();
		const result = await engine.requestExport({ saleId: sale.saleId, sellerId: buyer, kind: "orders" });
		expect(result).toEqual({
			ok: true,
			value: { ok: false, error: { code: "not_found", message: "No such sale" } },
		});
	});

	it("expired exports lose their file and their link [IO-export-expiry]", async () => {
		const { sale } = await paidSale();
		const jobId = await requested(sale.saleId, sale.sellerId, "orders");
		const { row } = await built(jobId);
		await db
			.prepare("UPDATE io_jobs SET expires_at = ?1 WHERE id = ?2")
			.bind(Date.now() - 1, jobId)
			.run();
		await Effect.runPromise(expireExports(deps()));
		expect(await job(jobId)).toMatchObject({ status: "expired", result_key: null });
		expect(await env.IMAGES.get(row["result_key"] as string)).toBeNull();
	});

	it("a job that isn't running any more is skipped [IO-export-expiry]", async () => {
		const { sale } = await paidSale();
		const jobId = await requested(sale.saleId, sale.sellerId, "orders");
		await db.prepare("UPDATE io_jobs SET status = 'failed' WHERE id = ?1").bind(jobId).run();
		expect(await Effect.runPromise(runExportJob(deps(), jobId, Date.now()))).toBe("skipped");
	});
});
