import { FREE_ITEM_CAP, type ImportBatchBody } from "@claimsale/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditOf, db, engine, makeSale, rejection, uid, value } from "./sale-fixtures.ts";

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	quiet = [vi.spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

/** A Pokémon single; core requires the name and condition. */
const single = (overrides: Record<string, string> = {}) => ({
	game: "pokemon",
	kind: "single",
	name: "Test Card",
	condition: "NM",
	price: "12.40",
	...overrides,
});

type Sale = Awaited<ReturnType<typeof makeSale>>;

const batch = (
	sale: Sale,
	rows: Record<string, string>[],
	options: Partial<ImportBatchBody> & { firstRow?: number } = {},
) => ({
	saleId: sale.saleId,
	sellerId: sale.sellerId,
	importId: options.importId ?? crypto.randomUUID(),
	format: "csv" as const,
	totalRows: options.totalRows ?? rows.length,
	rows: rows.map((cells, i) => ({ row: (options.firstRow ?? 2) + i, cells })),
	...(options.removeMissing !== undefined ? { removeMissing: options.removeMissing } : {}),
});

const apply = async (input: ReturnType<typeof batch>) => value(await engine.applyImportBatch(input));

const itemsOf = async (saleId: string) =>
	(
		await db
			.prepare(
				`SELECT id, sku, title, game_id, kind, condition, price_cents, version, attributes, catalog_product_id, sort_order
				FROM items WHERE sale_id = ?1 ORDER BY sort_order, id`,
			)
			.bind(saleId)
			.all<Record<string, unknown> & { id: string; attributes: string }>()
	).results.map((r): Record<string, unknown> & { id: string } => ({
		...r,
		attributes: JSON.parse(r.attributes) as Record<string, unknown>,
	}));

const jobOf = (importId: string) => db.prepare("SELECT * FROM io_jobs WHERE id = ?1").bind(importId).first();

beforeAll(async () => {
	await db.batch([
		db.prepare(
			`INSERT OR IGNORE INTO catalog_sets (id, game_id, code, name, tcgplayer_group_id, updated_at)
			VALUES (9100, 'pokemon', 'OBF', 'Obsidian Flames', 9100, 1)`,
		),
		db.prepare(
			`INSERT OR IGNORE INTO catalog_products (id, game_id, set_id, kind, name, number, rarity, tcgplayer_product_id, updated_at)
			VALUES (9101, 'pokemon', 9100, 'single', 'Charizard ex', '125/197', 'Double Rare', 9_100_001, 1),
			       (9102, 'pokemon', 9100, 'single', 'Pikachu', '062/197', 'Common', 9_100_002, 1)`,
		),
	]);
});

describe("item import batches in the engine (WS-G)", () => {
	it("[IO-import-validate] validates every row again; invalid rows are recorded and never written", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const result = await apply(
			batch(sale, [single({ sku: "A" }), single({ price: "", sku: "B" }), single({ condition: "Mint-ish" })]),
		);
		expect(result.rows.map((r) => [r.row, r.outcome])).toEqual([
			[2, "created"],
			[3, "error"],
			[4, "error"],
		]);
		expect(result.rows[1]).toMatchObject({ field: "price", message: "price: Price is required" });
		expect(result.rows[2]).toMatchObject({ field: "condition" });
		const items = await itemsOf(sale.saleId);
		expect(items).toEqual([
			expect.objectContaining({
				id: result.rows[0]!.itemId,
				sku: "A",
				game_id: "pokemon",
				kind: "single",
				title: "Test Card",
				condition: "NM",
				price_cents: 1240,
				sort_order: 0,
			}),
		]);
		const attrs = await db
			.prepare("SELECT key, value_text FROM item_attributes WHERE item_id = ?1 ORDER BY key")
			.bind(items[0]!.id)
			.all();
		expect(attrs.results).toEqual([
			{ key: "condition", value_text: "NM" },
			{ key: "name", value_text: "Test Card" },
		]);
		const audit = (await auditOf(sale.saleId)).filter((a) => a.action === "items_imported");
		expect(audit).toHaveLength(1);
		expect(audit[0]!.data["input"]).toMatchObject({ created: 1, errors: 2 });
	});

	it("[IO-import-idempotent] a re-sent batch returns the stored results and writes nothing", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const importId = crypto.randomUUID();
		const first = batch(sale, [single({ sku: "A" }), single({ sku: "B", price: "x" })], {
			importId,
			totalRows: 3,
		});
		const firstResult = await apply(first);
		expect(await apply(first)).toEqual(firstResult);
		expect(await itemsOf(sale.saleId)).toHaveLength(1);
		expect(await jobOf(importId)).toMatchObject({ created: 1, errors: 1, status: "applying", row_count: 3 });

		// Two deliveries at once still apply once (the sale lock serializes them).
		const next = batch(sale, [single({ sku: "C" })], { importId, totalRows: 3, firstRow: 4 });
		const [a, b] = await Promise.all([apply(next), apply(next)]);
		expect(a).toEqual(b);
		expect(await itemsOf(sale.saleId)).toHaveLength(2);
		expect(await jobOf(importId)).toMatchObject({ status: "done", created: 2, errors: 1 });
		const rows = await db
			.prepare("SELECT row_number, outcome FROM io_job_rows WHERE job_id = ?1 ORDER BY row_number")
			.bind(importId)
			.all();
		expect(rows.results).toEqual([
			{ row_number: 2, outcome: "created" },
			{ row_number: 3, outcome: "error" },
			{ row_number: 4, outcome: "created" },
		]);
		// WS-E's table isn't written any more (a later contract migration drops it).
		expect(
			await db.prepare("SELECT count(*) AS n FROM import_rows WHERE sale_id = ?1").bind(sale.saleId).first(),
		).toEqual({ n: 0 });
	});

	it("[IO-import-idempotent] refuses an import ID that belongs to another sale", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const other = await makeSale({ status: "draft", items: [], sellerId: sale.sellerId });
		const importId = crypto.randomUUID();
		await apply(batch(sale, [single()], { importId }));
		expect(rejection(await engine.applyImportBatch(batch(other, [single()], { importId })))).toBe(
			"import_conflict",
		);
	});

	it("[IO-import-upsert] updates by sku or item_id, skips unchanged rows and creates the rest", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		await apply(batch(sale, [single({ sku: "A" }), single({ sku: "B", name: "Pikachu" })]));
		const [a, b] = await itemsOf(sale.saleId);
		const result = await apply(
			batch(sale, [
				single({ sku: "a", price: "15" }), // SKUs match without case
				single({ item_id: b!.id, sku: "B", name: "Pikachu" }),
				single({ sku: "C", name: "Mew" }),
			]),
		);
		expect(result.rows.map((r) => [r.outcome, r.itemId])).toEqual([
			["updated", a!.id],
			["skipped", b!.id],
			["created", expect.any(String)],
		]);
		expect(result.rows[0]!.message).toContain("priceCents");
		expect((await itemsOf(sale.saleId)).map((i) => [i["sku"], i["price_cents"], i["version"]])).toEqual([
			["a", 1500, 1],
			["B", 1240, 0],
			["C", 1240, 0],
		]);
	});

	it("[IO-import-upsert] removes items not in the file only when asked, once per import, never with entries", async () => {
		const sale = await makeSale({
			status: "draft",
			items: [{ title: "Hand-entered" }, { title: "Has a claim" }],
			// This test adds the one photo whose R2 key it expects back; skip the fixture's own.
			photos: "none",
		});
		const buyer = await addUser();
		await db
			.prepare(
				"INSERT INTO entries (id, item_id, user_id, kind, amount_cents, status, created_at) VALUES (?1, ?2, ?3, 'claim', 4000, 'won', 1)",
			)
			.bind(uid("e"), sale.itemIds[1], buyer)
			.run();
		await db
			.prepare(
				"INSERT INTO item_images (id, sale_id, item_id, seller_id, r2_key, content_type, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'image/webp', 1, 1)",
			)
			.bind(uid("img"), sale.saleId, sale.itemIds[0], sale.sellerId, `photos/${uid("k")}.webp`)
			.run();
		await apply(batch(sale, [single({ sku: "A" }), single({ sku: "B" })]));

		const keep = { keepItemIds: [], keepSkus: ["a"] };
		const body = batch(sale, [single({ sku: "A" }), single({ name: "New card" })], { removeMissing: keep });
		const result = await apply(body);
		expect(result.removed).toBe(2); // the hand-entered item and B; the claimed item stays
		expect(result.removedR2Keys).toEqual([expect.stringMatching(/^photos\//)]);
		// Re-sending the first batch doesn't remove the item it just created.
		expect((await apply(body)).removed).toBe(0);
		expect((await itemsOf(sale.saleId)).map((i) => i["sku"] ?? i["title"])).toEqual([
			"Has a claim",
			"A",
			"New card",
		]);
		expect((await auditOf(sale.saleId)).map((a) => a.action)).toContain("items_import_removed");
	});

	it("[IO-import-cap] a free sale takes only the rows that fit; Pro has no cap", async () => {
		const sale = await makeSale({
			status: "draft",
			items: Array.from({ length: FREE_ITEM_CAP - 1 }, () => ({})),
		});
		const result = await apply(
			batch(sale, [single({ sku: "X" }), single({ sku: "Y" }), single({ sku: "Z" })]),
		);
		expect(result.rows.map((r) => r.outcome)).toEqual(["created", "error", "error"]);
		expect(result.rows[1]!.message).toBe("Free sales hold 10 items, so only 1 new row fit");
		const pro = await makeSale({
			status: "draft",
			sellerPro: true,
			items: Array.from({ length: FREE_ITEM_CAP }, () => ({})),
		});
		expect((await apply(batch(pro, [single()]))).rows[0]!.outcome).toBe("created");
	});

	it("[IO-import-target] only the seller's own draft or scheduled sale takes imports", async () => {
		const live = await makeSale({ status: "live", items: [] });
		expect(rejection(await engine.applyImportBatch(batch(live, [single()])))).toBe("sale_not_importable");
		const scheduled = await makeSale({ status: "scheduled", items: [] });
		expect((await apply(batch(scheduled, [single()]))).rows[0]!.outcome).toBe("created");
		const draft = await makeSale({ status: "draft", items: [] });
		const stranger = await addUser();
		expect(
			rejection(await engine.applyImportBatch({ ...batch(draft, [single()]), sellerId: stranger })),
		).toBe("not_found");
	});

	it("[TCG-catalog-match] links rows to the catalog and [TCG-autofill-only] fills only blank catalog fields", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const result = await apply(
			batch(sale, [
				single({ sku: "A", set_code: "obf", number: "125/197", name: "Zard (my name)" }),
				single({ sku: "B", tcgplayer_product_id: "9100002", name: "Pikachu", price: "1" }),
				single({ sku: "C", name: "Not In Catalog" }),
			]),
		);
		expect(result.rows.map((r) => r.outcome)).toEqual(["created", "created", "created"]);
		const [a, b, c] = await itemsOf(sale.saleId);
		expect(a).toMatchObject({
			catalog_product_id: "9101",
			title: "Zard (my name)",
			price_cents: 1240,
			attributes: {
				name: "Zard (my name)", // the file wins over the catalog
				set_code: "obf",
				number: "125/197",
				set_name: "Obsidian Flames",
				rarity: "Double Rare",
				tcgplayer_product_id: 9_100_001,
				condition: "NM",
			},
		});
		expect(b).toMatchObject({ catalog_product_id: "9102", price_cents: 100 });
		expect(c).toMatchObject({
			catalog_product_id: null,
			attributes: { name: "Not In Catalog", condition: "NM" },
		});
	});

	it("stores accessories without a game under the 'none' game id", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const result = await apply(
			batch(sale, [
				{ kind: "accessory", title: "Playmat", accessory_type: "playmat", condition: "new", price: "20" },
			]),
		);
		expect(result.rows[0]!.outcome).toBe("created");
		expect((await itemsOf(sale.saleId))[0]).toMatchObject({
			game_id: "none",
			kind: "accessory",
			condition: "new",
		});
	});

	it("refuses a malformed batch at the RPC boundary", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const tooMany = await engine.applyImportBatch({
			...batch(sale, []),
			rows: Array.from({ length: 101 }, (_, i) => ({ row: i + 2, cells: single() })),
		});
		expect(tooMany.ok).toBe(false);
		expect((await engine.applyImportBatch({ ...batch(sale, [single()]), importId: "not-a-uuid" })).ok).toBe(
			false,
		);
	});
});
