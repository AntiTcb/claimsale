import { DAY } from "@claimsale/core";
import { describe, expect, it } from "vitest";
import { rpcEngine, type EngineBinding } from "./engine.ts";

/**
 * The web side of the engine: input passes through to the SaleEngine over RPC and
 * outcomes come back unchanged. The rules themselves, including the photo checks, are
 * tested in the engine's Workers tests (apps/engine/test/sale-lifecycle.workers.test.ts,
 * apps/engine/test/photos.workers.test.ts).
 */

const now = Date.UTC(2026, 10, 15, 12);
const saleId = "sale-1";

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

describe("the engine over RPC", () => {
	it("passes publish to the SaleEngine and returns its outcome", async () => {
		const sale = { status: "scheduled", liveAt: now + DAY, closesAt: now + 2 * DAY };
		const { binding, calls } = fakeBinding({ ok: true, value: { ok: true, value: sale } });
		const result = await rpcEngine(binding).publish({
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

	it("[IMG-required] leaves the photo checks to the engine and returns its refusal unchanged", async () => {
		const rejection = {
			code: "photos_pending",
			message: "We're still checking the photos of 1 item. Try again in a minute.",
		};
		const { binding, calls } = fakeBinding({ ok: true, value: { ok: false, error: rejection } });
		expect(
			await rpcEngine(binding).publish({ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY }),
		).toEqual({ ok: false, error: rejection });
		expect(calls.map((c) => c.method)).toEqual(["publishSale"]);
	});

	it("returns the engine's rejection with its code and message", async () => {
		const rejection = {
			code: "sale_cap_reached",
			message: "Free sellers can have 2 sales scheduled or live",
		};
		const { binding } = fakeBinding({ ok: true, value: { ok: false, error: rejection } });
		expect(
			await rpcEngine(binding).publish({ saleId, sellerId: "seller", liveAt: null, closesAt: now + DAY }),
		).toEqual({ ok: false, error: rejection });
	});

	it("turns an engine failure into a retryable rejection", async () => {
		const { binding } = fakeBinding({ ok: false, error: { name: "Error", message: "boom" } });
		const engine = rpcEngine(binding);
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
		const engine = rpcEngine(binding);
		expect(await engine.unpublish({ saleId: "s1", sellerId: "seller" })).toEqual({ ok: true, value: sale });
		expect(await engine.close({ saleId: "s1", sellerId: "seller" })).toEqual({ ok: true, value: sale });
		expect(calls.map((c) => c.method)).toEqual(["unpublishSale", "closeSale"]);
	});
});
