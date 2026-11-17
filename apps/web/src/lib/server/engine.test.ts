import { DAY } from "@claimsale/core";
import { createDb, type Db } from "@claimsale/db";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, jpegBytes, memoryStore } from "../../../test/fixtures.ts";
import { rpcEngine, type EngineBinding } from "./engine.ts";
import { addItemPhoto } from "./images.ts";
import { addItem } from "./items.ts";
import { createDraft } from "./sales.ts";

/**
 * The web side of the engine: input passes through to the SaleEngine over RPC and
 * outcomes come back unchanged. The rules themselves are tested in the engine's
 * Workers tests (apps/engine/test/sale-lifecycle.workers.test.ts).
 */

let db: Db;
const now = Date.UTC(2026, 10, 15, 12);
const store = memoryStore();

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
});

type Call = { method: string; input: unknown };

/** A fake ENGINE binding that records calls and answers with `answer`. */
function fakeBinding(answer: unknown): { binding: EngineBinding; calls: Call[] } {
	const calls: Call[] = [];
	const method = (name: string) => async (input: unknown) => {
		calls.push({ method: name, input });
		return answer;
	};
	return {
		binding: {
			publishSale: method("publishSale"),
			unpublishSale: method("unpublishSale"),
			closeSale: method("closeSale"),
		} as unknown as EngineBinding,
		calls,
	};
}

async function draft(photos: boolean) {
	const seller = { id: "seller", tier: "free" as const };
	const sale = await createDraft(
		db,
		seller,
		{ title: "Sale", descriptionMd: "", visibility: "unlisted" },
		now,
	);
	if (!sale.ok) throw new Error("setup");
	const item = await addItem(
		db,
		seller,
		sale.value.id,
		{
			title: "Card",
			priceCents: 500,
			quantity: 1,
			gameId: "pokemon",
			kind: "single",
			condition: "NM",
			attributes: {},
		},
		now,
	);
	if (!item.ok) throw new Error("setup");
	if (photos) {
		await addItemPhoto(
			db,
			store,
			seller,
			{ saleId: sale.value.id, itemId: item.value.id },
			jpegBytes(10, 10),
			now,
		);
	}
	return sale.value.id;
}

describe("the engine over RPC", () => {
	it("passes publish to the SaleEngine and returns its outcome", async () => {
		const saleId = await draft(true);
		const sale = { status: "scheduled", liveAt: now + DAY, closesAt: now + 2 * DAY };
		const { binding, calls } = fakeBinding({ ok: true, value: { ok: true, value: sale } });
		const result = await rpcEngine(binding, db).publish({
			saleId,
			sellerId: "seller",
			liveAt: now + DAY,
			closesAt: now + 2 * DAY,
		});
		expect(result).toEqual({ ok: true, value: sale });
		expect(calls).toEqual([
			{
				method: "publishSale",
				input: { saleId, sellerId: "seller", liveAt: now + DAY, closesAt: now + 2 * DAY },
			},
		]);
	});

	it("checks every item has a photo before asking the engine", async () => {
		const saleId = await draft(false);
		const { binding, calls } = fakeBinding({ ok: true, value: { ok: true, value: {} } });
		const result = await rpcEngine(binding, db).publish({
			saleId,
			sellerId: "seller",
			liveAt: null,
			closesAt: now + DAY,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "missing_photos" } });
		expect(calls).toEqual([]);
	});

	it("returns the engine's rejection with its code and message", async () => {
		const saleId = await draft(true);
		const rejection = {
			code: "sale_cap_reached",
			message: "Free sellers can have 2 sales scheduled or live",
		};
		const { binding } = fakeBinding({ ok: true, value: { ok: false, error: rejection } });
		expect(
			await rpcEngine(binding, db).publish({ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY }),
		).toEqual({ ok: false, error: rejection });
	});

	it("turns an engine failure into a retryable rejection", async () => {
		const { binding } = fakeBinding({ ok: false, error: { name: "Error", message: "boom" } });
		const engine = rpcEngine(binding, db);
		for (const result of [
			await engine.unpublish({ saleId: "s", sellerId: "seller" }),
			await engine.close({ saleId: "s", sellerId: "seller" }),
		]) {
			expect(result).toMatchObject({ ok: false, error: { code: "engine_unavailable" } });
		}
	});

	it("passes unpublish and close through", async () => {
		const sale = { status: "draft", liveAt: null, closesAt: null };
		const { binding, calls } = fakeBinding({ ok: true, value: { ok: true, value: sale } });
		const engine = rpcEngine(binding, db);
		expect(await engine.unpublish({ saleId: "s1", sellerId: "seller" })).toEqual({ ok: true, value: sale });
		expect(await engine.close({ saleId: "s1", sellerId: "seller" })).toEqual({ ok: true, value: sale });
		expect(calls.map((c) => c.method)).toEqual(["unpublishSale", "closeSale"]);
	});
});
