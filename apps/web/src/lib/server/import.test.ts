import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FREE_ITEM_CAP } from "@claimsale/core";
import { createDb, eq, sql, type Db } from "@claimsale/db";
import { auditLog, ioJobs, itemAttributes, items, sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, grantSellerPro } from "../../../test/fixtures.ts";
import { addItem, listItems } from "./items.ts";
import { applyImportBatch, importResults, type ImportBatchBody } from "./import.ts";
import { createDraft } from "./sales.ts";

let db: Db;
let saleId: string;
const free = { id: "seller", tier: "free" as const };
const pro = { id: "seller", tier: "pro" as const };
const IMPORT_A = "0190a000-0000-7000-8000-000000000001";
const IMPORT_B = "0190a000-0000-7000-8000-000000000002";

const card = (overrides: Record<string, string> = {}) => ({
	game: "yugioh",
	kind: "single",
	name: "Blue-Eyes White Dragon",
	condition: "NM",
	price: "40",
	...overrides,
});

const batch = (
	rows: Record<string, string>[],
	options: Partial<ImportBatchBody> & { firstRow?: number } = {},
): ImportBatchBody => ({
	importId: options.importId ?? IMPORT_A,
	format: "csv",
	totalRows: options.totalRows ?? rows.length,
	rows: rows.map((cells, i) => ({ row: (options.firstRow ?? 2) + i, cells })),
	...(options.removeMissing !== undefined ? { removeMissing: options.removeMissing } : {}),
});

async function apply(body: ImportBatchBody, seller: { id: string; tier: "free" | "pro" } = free, now = 100) {
	const result = await applyImportBatch(db, seller, saleId, body, now);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

async function seedCatalog(): Promise<void> {
	await db.run(sql`INSERT INTO catalog_sets (id, game_id, code, name, tcgplayer_group_id, updated_at)
		VALUES (1, 'yugioh', 'LOB', 'Legend of Blue Eyes White Dragon', 100, 1)`);
	await db.run(sql`INSERT INTO catalog_products (id, game_id, set_id, kind, name, number, rarity, tcgplayer_product_id, updated_at)
		VALUES (7, 'yugioh', 1, 'single', 'Blue-Eyes White Dragon', 'LOB-001', 'Ultra Rare', 5001, 1),
		       (8, 'yugioh', 1, 'single', 'Dark Magician', 'LOB-005', 'Ultra Rare', 5005, 1)`);
	await db.run(sql`INSERT INTO market_prices (product_id, subtype, market_cents, as_of)
		VALUES (7, '1st Edition', 12000, 1), (7, 'Unlimited', 4000, 1)`);
}

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	await addUser(db, "other");
	const sale = await createDraft(db, free, { title: "Sale", descriptionMd: "", visibility: "unlisted" }, 1);
	if (!sale.ok) throw new Error("setup");
	saleId = sale.value.id;
});

describe("applyImportBatch", () => {
	it("[IO-import-validate] re-validates every row on the server; invalid rows are recorded and never written", async () => {
		const result = await apply(
			batch([card({ sku: "A" }), card({ price: "", sku: "B" }), card({ condition: "Mint-ish", sku: "C" })]),
		);
		expect(result.rows.map((r) => [r.row, r.outcome])).toEqual([
			[2, "created"],
			[3, "error"],
			[4, "error"],
		]);
		expect(result.rows[1]).toMatchObject({ field: "price", message: "price: Price is required" });
		expect(result.rows[2]).toMatchObject({ field: "condition" });
		const stored = await listItems(db, saleId);
		expect(stored.map((i) => i.sku)).toEqual(["A"]);
		expect(stored[0]).toMatchObject({
			gameId: "yugioh",
			kind: "single",
			title: "Blue-Eyes White Dragon",
			condition: "NM",
			priceCents: 4000,
			attributes: { name: "Blue-Eyes White Dragon", condition: "NM" },
		});
		const attrs = await db
			.select()
			.from(itemAttributes)
			.where(eq(itemAttributes.itemId, stored[0]!.id))
			.all();
		expect(attrs.map((a) => a.key).toSorted()).toEqual(["condition", "name"]);
	});

	it("[IO-import-idempotent] a re-sent batch returns the stored results and writes nothing", async () => {
		const body = batch([card({ sku: "A" }), card({ sku: "B", price: "x" })], { totalRows: 3 });
		const first = await apply(body);
		const again = await apply(body, free, 200);
		expect(again.rows).toEqual(first.rows);
		expect(await listItems(db, saleId)).toHaveLength(1);
		const job = await db.select().from(ioJobs).where(eq(ioJobs.id, IMPORT_A)).get();
		expect(job).toMatchObject({ created: 1, errors: 1, status: "applying", rowCount: 3 });
		const audits = await db.select().from(auditLog).where(eq(auditLog.action, "items_imported")).all();
		expect(audits).toHaveLength(1);

		// The last row arrives in the next batch; the job is then done.
		await apply(batch([card({ sku: "C" })], { totalRows: 3, firstRow: 4 }));
		expect(await db.select().from(ioJobs).where(eq(ioJobs.id, IMPORT_A)).get()).toMatchObject({
			status: "done",
			created: 2,
			finishedAt: 100,
		});
		expect((await importResults(db, "seller", IMPORT_A))?.map((r) => r.row)).toEqual([2, 3, 4]);
		expect(await importResults(db, "other", IMPORT_A)).toBeNull();
	});

	it("[IO-import-idempotent] refuses an import ID that belongs to another seller or sale", async () => {
		await apply(batch([card()]));
		const other = await createDraft(
			db,
			free,
			{ title: "Other", descriptionMd: "", visibility: "unlisted" },
			1,
		);
		if (!other.ok) throw new Error("setup");
		expect(await applyImportBatch(db, free, other.value.id, batch([card()]), 1)).toMatchObject({
			ok: false,
			error: { code: "import_conflict" },
		});
	});

	it("[IO-import-upsert] updates by sku or item_id, skips unchanged rows and creates the rest", async () => {
		await apply(batch([card({ sku: "A" }), card({ sku: "B", name: "Dark Magician" })]));
		const [a, b] = await listItems(db, saleId);
		const result = await apply(
			batch(
				[
					card({ sku: "a", price: "45" }), // SKUs match without case
					card({ item_id: b!.id, sku: "B", name: "Dark Magician" }),
					card({ sku: "C", name: "Kuriboh" }),
				],
				{ importId: IMPORT_B },
			),
		);
		expect(result.rows.map((r) => [r.outcome, r.itemId])).toEqual([
			["updated", a!.id],
			["skipped", b!.id],
			["created", expect.any(String)],
		]);
		expect(result.rows[0]!.message).toContain("priceCents");
		const after = await listItems(db, saleId);
		expect(after.map((i) => [i.sku, i.priceCents, i.version])).toEqual([
			["a", 4500, 1],
			["B", 4000, 0],
			["C", 4000, 0],
		]);
	});

	it("[IO-import-upsert] removes items not in the file only when asked, once per import", async () => {
		const manual = await addItem(
			db,
			free,
			saleId,
			{
				title: "Hand-entered",
				priceCents: 100,
				quantity: 1,
				gameId: "yugioh",
				kind: "single",
				condition: null,
				attributes: {},
			},
			1,
		);
		if (!manual.ok) throw new Error("setup");
		await apply(batch([card({ sku: "A" }), card({ sku: "B" })]));
		expect(await listItems(db, saleId)).toHaveLength(3);

		const keep = { keepItemIds: [], keepSkus: ["a"] };
		const body = batch([card({ sku: "A" }), card({ name: "New card" })], {
			importId: IMPORT_B,
			removeMissing: keep,
		});
		const result = await apply(body);
		expect(result.removed).toBe(2);
		// Re-sending the first batch doesn't remove the item it just created.
		expect((await apply(body)).removed).toBe(0);
		expect((await listItems(db, saleId)).map((i) => i.sku ?? i.title)).toEqual(["A", "New card"]);
	});

	it("[IO-import-cap] a free sale takes only the rows that fit; Pro has no cap", async () => {
		for (let i = 0; i < FREE_ITEM_CAP - 1; i++)
			await apply(
				batch([card({ sku: `S${i}` })], {
					importId: `0190a000-0000-7000-8000-0000000001${String(i).padStart(2, "0")}`,
				}),
			);
		const result = await apply(batch([card({ sku: "X" }), card({ sku: "Y" }), card({ sku: "Z" })]));
		expect(result.rows.map((r) => r.outcome)).toEqual(["created", "error", "error"]);
		expect(result.rows[1]!.message).toBe("Free sales hold 10 items, so only 1 new row fit");
		await grantSellerPro(db, "seller");
		const more = await apply(batch([card({ sku: "Y" })], { importId: IMPORT_B }), pro);
		expect(more.rows[0]!.outcome).toBe("created");
	});

	it("[IO-import-target] imports only into the seller's own draft or scheduled sale", async () => {
		await db.update(sales).set({ status: "live" }).where(eq(sales.id, saleId));
		expect(await applyImportBatch(db, free, saleId, batch([card()]), 1)).toMatchObject({
			ok: false,
			error: { code: "sale_not_importable" },
		});
		await db.update(sales).set({ status: "scheduled" }).where(eq(sales.id, saleId));
		expect((await applyImportBatch(db, free, saleId, batch([card()]), 1)).ok).toBe(true);
		expect(
			await applyImportBatch(db, { id: "other", tier: "free" }, saleId, batch([card()]), 1),
		).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
	});

	it("[TCG-catalog-match] links rows to the catalog and [TCG-autofill-only] fills only blank catalog fields", async () => {
		await seedCatalog();
		const result = await apply(
			batch([
				card({ sku: "A", set_code: "lob", number: "LOB-001", name: "BEWD (my name)" }),
				card({ sku: "B", tcgplayer_product_id: "5005", name: "Dark Magician", price: "12" }),
				card({ sku: "C", name: "Not In Catalog" }),
			]),
		);
		expect(result.rows.map((r) => r.outcome)).toEqual(["created", "created", "created"]);
		const [a, b, c] = await listItems(db, saleId);
		expect(a).toMatchObject({
			catalogProductId: "7",
			title: "BEWD (my name)",
			condition: "NM",
			priceCents: 4000,
			attributes: {
				name: "BEWD (my name)", // the file wins over the catalog
				set_code: "lob",
				number: "LOB-001",
				set_name: "Legend of Blue Eyes White Dragon",
				rarity: "Ultra Rare",
				tcgplayer_product_id: 5001,
				condition: "NM",
			},
		});
		expect(b).toMatchObject({ catalogProductId: "8", priceCents: 1200 });
		expect(c).toMatchObject({
			catalogProductId: null,
			attributes: { name: "Not In Catalog", condition: "NM" },
		});
	});

	it("stores accessories without a game under the 'none' game id", async () => {
		const result = await apply(
			batch([
				{ kind: "accessory", title: "Playmat", accessory_type: "playmat", condition: "new", price: "20" },
			]),
		);
		expect(result.rows[0]!.outcome).toBe("created");
		const [mat] = await db.select().from(items).all();
		expect(mat).toMatchObject({ gameId: "none", kind: "accessory", condition: "new" });
	});
});

describe("migration 0006_io_jobs", () => {
	const MIGRATIONS = join(import.meta.dirname, "../../../../../packages/db/migrations");
	const statements = readFileSync(join(MIGRATIONS, "0006_io_jobs.sql"), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^--.*$/gm, "").trim())
		.filter(Boolean);

	it("only adds tables and indexes (expand step)", () => {
		expect(statements.length).toBeGreaterThan(0);
		for (const statement of statements) expect(statement).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) /i);
	});

	it("applies on top of the previous schema without touching existing data", () => {
		const sqlite = new DatabaseSync(":memory:");
		const files = [
			"0000_init",
			"0001_auth",
			"0002_sales_items",
			"0003_catalog",
			"0004_catalog_search",
			"0005_games_registry",
		];
		const run = (file: string) => {
			for (const s of readFileSync(join(MIGRATIONS, `${file}.sql`), "utf8").split("--> statement-breakpoint"))
				if (s.trim()) sqlite.exec(s);
		};
		for (const file of files) run(file);
		sqlite.exec(
			"INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@example.test', 'A', 1, 1)",
		);
		run("0006_io_jobs");
		expect(sqlite.prepare("SELECT id FROM users").all()).toEqual([{ id: "u1" }]);
		expect(sqlite.prepare("SELECT count(*) AS n FROM io_jobs").get()).toEqual({ n: 0 });
	});
});
