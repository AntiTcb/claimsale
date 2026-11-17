import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditOf, db, engine, makeSale, rejection, uid, value } from "./sale-fixtures.ts";

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	quiet = [vi.spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

const single = (row: number, overrides: Record<string, string> = {}) => ({
	row,
	cells: {
		game: "pokemon",
		kind: "single",
		name: `Card ${row}`,
		condition: "NM",
		price: "12.40",
		...overrides,
	},
});

const itemsOf = async (saleId: string) =>
	(
		await db
			.prepare(
				"SELECT id, sku, title, price_cents, condition, attributes, sort_order FROM items WHERE sale_id = ?1 ORDER BY sort_order",
			)
			.bind(saleId)
			.all()
	).results;

describe("item import batches (WS-G's applyImportBatch)", () => {
	it("creates and updates items from validated rows [IO-import-upsert] [IO-import-validate]", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const importId = uid("imp");
		const first = value(
			await engine.applyImportBatch({
				saleId: sale.saleId,
				sellerId: sale.sellerId,
				importId,
				rows: [single(2, { sku: "A-1" }), single(3, { price: "abc" }), single(4)],
			}),
		);
		expect(first.outcomes).toEqual([
			{ row: 2, outcome: "created", itemId: expect.any(String) },
			{ row: 3, outcome: "error", field: "price", message: expect.any(String) },
			{ row: 4, outcome: "created", itemId: expect.any(String) },
		]);
		expect(await itemsOf(sale.saleId)).toEqual([
			expect.objectContaining({
				sku: "A-1",
				title: "Card 2",
				price_cents: 1240,
				condition: "NM",
				sort_order: 0,
			}),
			expect.objectContaining({ sku: null, title: "Card 4", sort_order: 1 }),
		]);
		// A later import updates by SKU.
		const second = value(
			await engine.applyImportBatch({
				saleId: sale.saleId,
				sellerId: sale.sellerId,
				importId: uid("imp"),
				rows: [single(2, { sku: "A-1", price: "15.00" })],
			}),
		);
		expect(second.outcomes).toEqual([
			expect.objectContaining({
				row: 2,
				outcome: "updated",
				changed: expect.arrayContaining(["priceCents"]),
			}),
		]);
		expect((await itemsOf(sale.saleId))[0]).toMatchObject({ sku: "A-1", price_cents: 1500 });
		expect((await auditOf(sale.saleId)).map((a) => a.action)).toEqual(["items_imported", "items_imported"]);
	});

	it("a re-sent batch is a no-op that returns the first outcomes [IO-import-idempotent]", async () => {
		const sale = await makeSale({ status: "draft", items: [] });
		const batch = {
			saleId: sale.saleId,
			sellerId: sale.sellerId,
			importId: uid("imp"),
			rows: [single(2), single(3)],
		};
		const first = value(await engine.applyImportBatch(batch));
		const again = value(await engine.applyImportBatch(batch));
		expect(again.replayed).toBe(2);
		expect(again.outcomes).toEqual(first.outcomes);
		expect(await itemsOf(sale.saleId)).toHaveLength(2);
		// Two deliveries at once still apply once.
		const concurrent = { ...batch, importId: uid("imp"), rows: [single(5)] };
		await Promise.all([engine.applyImportBatch(concurrent), engine.applyImportBatch(concurrent)]);
		expect(await itemsOf(sale.saleId)).toHaveLength(3);
	});

	it("only draft and scheduled sales take imports [IO-import-target]", async () => {
		const sale = await makeSale({ status: "live", items: [] });
		expect(
			rejection(
				await engine.applyImportBatch({
					saleId: sale.saleId,
					sellerId: sale.sellerId,
					importId: uid("imp"),
					rows: [single(2)],
				}),
			),
		).toBe("sale_not_importable");
		const other = await addUser();
		const draft = await makeSale({ status: "draft", items: [] });
		expect(
			rejection(
				await engine.applyImportBatch({
					saleId: draft.saleId,
					sellerId: other,
					importId: uid("imp"),
					rows: [single(2)],
				}),
			),
		).toBe("not_found");
	});

	it("keeps the free item cap across batches and reports what fits [IO-import-cap]", async () => {
		const sale = await makeSale({ status: "draft", items: Array.from({ length: 8 }, () => ({})) });
		const result = value(
			await engine.applyImportBatch({
				saleId: sale.saleId,
				sellerId: sale.sellerId,
				importId: uid("imp"),
				rows: [single(2), single(3), single(4)],
			}),
		);
		expect(result.outcomes.map((o) => o.outcome)).toEqual(["created", "created", "error"]);
		expect(result.outcomes[2]).toMatchObject({ message: expect.stringContaining("only 2 new rows fit") });
		expect(await itemsOf(sale.saleId)).toHaveLength(10);
	});
});
