import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_CRON, groupsPerRun } from "../src/catalog/index.ts";
import Engine from "../src/index.ts";
import { ingestCatalog, type IngestOptions } from "../src/catalog/ingest.ts";
import { searchCatalog, sellerMarketPrices } from "../src/catalog/search.ts";
import { TcgCsvLive, USER_AGENT } from "../src/catalog/tcgcsv.ts";
import { FIXTURE_BASE, FIXTURE_BUILD, fakeTcgCsv, NEXT_BUILD, type FakeTcgCsv } from "./tcgcsv-fixtures.ts";

const db = env.DB;

async function resetCatalog() {
	await db.batch([
		db.prepare("DELETE FROM want_list_items"),
		db.prepare("DELETE FROM market_prices"),
		db.prepare("DELETE FROM catalog_products"),
		db.prepare("DELETE FROM catalog_sets"),
		db.prepare("UPDATE games SET synced_build = NULL, synced_at = NULL, enabled = (sort_order <= 100)"),
	]);
}

function ingest(fake: FakeTcgCsv, options: Partial<IngestOptions> = {}, retries = 0) {
	return Effect.runPromise(
		ingestCatalog(db, { maxGroups: 50, ...options }).pipe(
			Effect.provide(TcgCsvLive({ baseUrl: FIXTURE_BASE, fetch: fake.fetch, spacing: 0, retries })),
		),
	);
}

const count = async (table: string) =>
	(await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

const search = (query: string, extra: { game?: string; limit?: number } = {}) =>
	Effect.runPromise(searchCatalog(db, { query, ...extra }));

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(async () => {
	await resetCatalog();
	// Ingestion logs a JSON summary line; keep test output readable.
	quiet = [
		vi.spyOn(console, "log").mockImplementation(() => {}),
		vi.spyOn(console, "warn").mockImplementation(() => {}),
	];
});
afterEach(() => {
	for (const spy of quiet) spy.mockRestore();
});

describe("catalog ingestion from TCGCSV fixtures", () => {
	it("ingests sets, products and latest prices for an enabled game [TCG-catalog-ingest]", async () => {
		const fake = fakeTcgCsv();
		const summary = await ingest(fake, { game: "riftbound" });

		expect(summary).toMatchObject({
			build: FIXTURE_BUILD,
			upToDate: false,
			games: 1,
			gamesFailed: 0,
			setsWritten: 2,
			groupsIngested: 2,
			groupsFailed: 0,
			groupsRemaining: 0,
			productsWritten: 12,
			// 9 + 4 rows; the price for a product that isn't in the catalog is dropped.
			pricesWritten: 13,
			requests: 6,
		});
		const annie = await db
			.prepare(
				`SELECT p.kind, p.name, p.number, p.rarity, p.product_type, s.name AS set_name, s.code, s.release_date, m.market_cents
				FROM catalog_products p JOIN catalog_sets s ON s.id = p.set_id JOIN market_prices m ON m.product_id = p.id
				WHERE p.tcgplayer_product_id = 653136`,
			)
			.first();
		expect(annie).toEqual({
			kind: "single",
			name: "Annie, Fiery",
			number: "001/024",
			rarity: "Epic",
			product_type: null,
			set_name: "Origins: Proving Grounds",
			code: "OGS",
			release_date: "2025-10-31",
			market_cents: 425,
		});
		const sealed = await db
			.prepare(
				"SELECT kind, product_type FROM catalog_products WHERE tcgplayer_product_id IN (635460, 663920) ORDER BY tcgplayer_product_id",
			)
			.all();
		expect(sealed.results).toEqual([
			{ kind: "sealed", product_type: "Box Set" },
			{ kind: "sealed", product_type: "Case" },
		]);
		// Every product is in the FTS index (kept in sync by triggers).
		expect(await count("catalog_search")).toBe(await count("catalog_products"));
		const game = await db.prepare("SELECT synced_build FROM games WHERE id = 'riftbound'").first();
		expect(game).toEqual({ synced_build: FIXTURE_BUILD });
	});

	it("sends a descriptive User-Agent and only calls the configured base URL", async () => {
		const fake = fakeTcgCsv();
		await ingest(fake, { game: "riftbound" });
		expect(new Set(fake.userAgents)).toEqual(new Set([USER_AGENT]));
		expect(fake.requests[0]).toBe("/last-updated.txt");
	});

	it("re-running the same build costs one request and writes nothing [TCG-catalog-ingest]", async () => {
		const fake = fakeTcgCsv();
		await ingest(fake, { game: "riftbound" });
		const again = fakeTcgCsv();
		const summary = await ingest(again, { game: "riftbound" });
		expect(summary).toMatchObject({
			upToDate: true,
			groupsIngested: 0,
			productsWritten: 0,
			pricesWritten: 0,
		});
		expect(again.requests).toEqual(["/last-updated.txt"]);
	});

	it("a new build with unchanged data re-reads every set but writes no rows [TCG-catalog-ingest]", async () => {
		await ingest(fakeTcgCsv(), { game: "riftbound" });
		const before = await db.prepare("SELECT * FROM catalog_products ORDER BY id").all();
		const pricesBefore = await db.prepare("SELECT * FROM market_prices ORDER BY product_id, subtype").all();

		const next = fakeTcgCsv();
		next.files["/last-updated.txt"] = NEXT_BUILD;
		const summary = await ingest(next, { game: "riftbound" });

		expect(summary).toMatchObject({
			build: NEXT_BUILD,
			setsWritten: 0,
			groupsIngested: 2,
			productsWritten: 0,
			pricesWritten: 0,
			groupsRemaining: 0,
		});
		expect((await db.prepare("SELECT * FROM catalog_products ORDER BY id").all()).results).toEqual(
			before.results,
		);
		expect(
			(await db.prepare("SELECT * FROM market_prices ORDER BY product_id, subtype").all()).results,
		).toEqual(pricesBefore.results);
		const synced = await db.prepare("SELECT DISTINCT synced_build FROM catalog_sets").all();
		expect(synced.results).toEqual([{ synced_build: NEXT_BUILD }]);
	});

	it("applies changed names and prices, and keeps search in sync [TCG-catalog-ingest]", async () => {
		await ingest(fakeTcgCsv(), { game: "riftbound" });
		const next = fakeTcgCsv();
		next.files["/last-updated.txt"] = NEXT_BUILD;
		next.files["/tcgplayer/89/24439/products"] = next.files[
			"/tcgplayer/89/24439/products"
		]!.toString().replace('"Firestorm"', '"Firestorm (Errata)"');
		next.files["/tcgplayer/89/24439/prices"] = next.files["/tcgplayer/89/24439/prices"]!.toString().replace(
			'"marketPrice": 4.25',
			'"marketPrice": 4.5',
		);
		const summary = await ingest(next, { game: "riftbound" });

		expect(summary).toMatchObject({ productsWritten: 1, pricesWritten: 1 });
		const price = await db
			.prepare(
				"SELECT m.market_cents, m.as_of FROM market_prices m JOIN catalog_products p ON p.id = m.product_id WHERE p.tcgplayer_product_id = 653136",
			)
			.first();
		expect(price).toEqual({ market_cents: 450, as_of: Date.parse("2026-11-16T20:05:00Z") });
		expect((await search("errata")).map((h) => h.name)).toEqual(["Firestorm (Errata)"]);
		expect(await count("catalog_search")).toBe(await count("catalog_products"));
	});

	it("stops at the per-run budget and resumes on the next run [TCG-catalog-ingest]", async () => {
		const first = await ingest(fakeTcgCsv(), { game: "riftbound", maxGroups: 1 });
		expect(first).toMatchObject({ groupsIngested: 1, groupsRemaining: 1 });
		const second = fakeTcgCsv();
		const resumed = await ingest(second, { game: "riftbound", maxGroups: 1 });
		expect(resumed).toMatchObject({ groupsIngested: 1, groupsRemaining: 0, setsWritten: 0 });
		// The group list was already read for this build, so only the remaining set is fetched.
		expect(second.requests).toEqual([
			"/last-updated.txt",
			"/tcgplayer/89/24343/products",
			"/tcgplayer/89/24343/prices",
		]);
	});

	it("leaves a failing set behind for the next run and ingests the rest [TCG-catalog-ingest]", async () => {
		const fake = fakeTcgCsv();
		fake.files["/tcgplayer/89/24343/prices"] = () => new Response("upstream down", { status: 503 });
		const summary = await ingest(fake, { game: "riftbound" });
		expect(summary).toMatchObject({ groupsIngested: 1, groupsFailed: 1, groupsRemaining: 1 });
		// Nothing of the failed set's batch is marked current.
		const promo = await db
			.prepare("SELECT synced_build FROM catalog_sets WHERE tcgplayer_group_id = 24343")
			.first();
		expect(promo).toEqual({ synced_build: null });

		const retry = await ingest(fakeTcgCsv(), { game: "riftbound" });
		expect(retry).toMatchObject({ groupsIngested: 1, groupsFailed: 0, groupsRemaining: 0 });
	});

	it("retries a transient 5xx before giving up", async () => {
		const fake = fakeTcgCsv();
		let calls = 0;
		const body = fake.files["/tcgplayer/89/groups"] as string;
		fake.files["/tcgplayer/89/groups"] = () =>
			++calls === 1 ? new Response("busy", { status: 502 }) : new Response(body, { status: 200 });
		const summary = await ingest(fake, { game: "riftbound" }, 1);
		expect(calls).toBe(2);
		expect(summary).toMatchObject({ gamesFailed: 0, groupsIngested: 2 });
	});

	it("does not retry a 404 and reports the game as failed", async () => {
		const fake = fakeTcgCsv();
		delete fake.files["/tcgplayer/89/groups"];
		const summary = await ingest(fake, { game: "riftbound" }, 2);
		expect(summary).toMatchObject({ gamesFailed: 1, groupsIngested: 0 });
		expect(fake.requests.filter((p) => p === "/tcgplayer/89/groups")).toHaveLength(1);
	});

	it("re-ingests every set of a game when forced", async () => {
		await ingest(fakeTcgCsv(), { game: "riftbound" });
		const fake = fakeTcgCsv();
		const summary = await ingest(fake, { game: "riftbound", force: true });
		expect(summary).toMatchObject({ upToDate: false, groupsIngested: 2, productsWritten: 0 });
		expect(fake.requests).toHaveLength(6);
	});

	it("rejects an unknown or disabled game", async () => {
		await expect(ingest(fakeTcgCsv(), { game: "pokemon-japan" })).rejects.toThrow(/No enabled game/);
		await expect(ingest(fakeTcgCsv(), { game: "nope" })).rejects.toThrow(/No enabled game/);
	});

	it("skips disabled games in a full run and fails a game whose groups are missing", async () => {
		const fake = fakeTcgCsv();
		const summary = await ingest(fake);
		// Ten enabled launch games; only Riftbound has fixtures, the rest answer 404.
		expect(summary).toMatchObject({ games: 10, gamesFailed: 9, groupsIngested: 2 });
		expect(fake.requests).not.toContain("/tcgplayer/85/groups");
	});
});

describe("catalog search (FTS5 type-ahead)", () => {
	beforeEach(async () => {
		await ingest(fakeTcgCsv(), { game: "riftbound" });
	});

	it("ranks an exact name first, then names starting with the query", async () => {
		const hits = await search("annie fiery");
		expect(hits.map((h) => h.name)).toEqual(["Annie, Fiery", "Annie, Fiery (Alternate Art)"]);
	});

	it("ranks names starting with the word above names that only contain it", async () => {
		const names = (await search("annie")).map((h) => h.name);
		expect(names.slice(0, 3).toSorted()).toEqual([
			"Annie, Dark Child (Starter)",
			"Annie, Fiery",
			"Annie, Fiery (Alternate Art)",
		]);
		expect(names.at(-1)).toBe("Riftbound Promo Booster Pack: Annie");
	});

	it("matches word prefixes as the seller types", async () => {
		expect((await search("tibb")).map((h) => h.name)).toEqual(["Tibbers", "Tibbers, Unleashed"]);
		expect((await search("master yi h")).map((h) => h.name)).toEqual(["Master Yi, Honed"]);
	});

	it("finds a card by collector number and set code", async () => {
		const [hit] = await search("OGS 001");
		expect(hit).toEqual({
			productId: expect.any(Number),
			tcgplayerProductId: 653136,
			game: "riftbound",
			kind: "single",
			name: "Annie, Fiery",
			setName: "Origins: Proving Grounds",
			setCode: "OGS",
			number: "001/024",
			rarity: "Epic",
			productType: null,
		});
	});

	it("finds sealed product with its product type", async () => {
		const [hit] = await search("proving grounds case");
		expect(hit).toMatchObject({ kind: "sealed", productType: "Case", tcgplayerProductId: 663920 });
	});

	it("treats FTS syntax in the input as plain words", async () => {
		await expect(search('annie" OR name:* NEAR(')).resolves.toBeInstanceOf(Array);
		expect(await search("***")).toEqual([]);
		expect(await search("")).toEqual([]);
	});

	it("filters by game and leaves out disabled games", async () => {
		expect(await search("annie", { game: "pokemon" })).toEqual([]);
		expect((await search("annie", { game: "riftbound", limit: 2 })).length).toBe(2);
		await db.prepare("UPDATE games SET enabled = 0 WHERE id = 'riftbound'").run();
		expect(await search("annie")).toEqual([]);
	});

	it("search hits never carry market prices [TCG-market-placeholder]", async () => {
		for (const hit of await search("annie")) {
			expect(Object.keys(hit).some((k) => /price|market|cents/i.test(k))).toBe(false);
		}
	});

	it("is exposed over RPC with input validation", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const ok = await exports.default.searchCatalog({ query: "tibbers" });
		expect(ok).toMatchObject({ ok: true, value: [{ name: "Tibbers" }, { name: "Tibbers, Unleashed" }] });
		const bad = await exports.default.searchCatalog({ query: "x".repeat(101) });
		expect(bad).toMatchObject({ ok: false, error: { name: "SchemaError" } });
		error.mockRestore();
	});
});

const productId = async (tcgplayerId: number) =>
	(await db
		.prepare("SELECT id FROM catalog_products WHERE tcgplayer_product_id = ?")
		.bind(tcgplayerId)
		.first<{ id: number }>())!.id;

describe("seller market price lookup", () => {
	const seller = { userId: "u_seller", canSell: true };

	beforeEach(async () => {
		await ingest(fakeTcgCsv(), { game: "riftbound" });
	});

	it("returns every subtype's market price in cents to a seller [TCG-market-placeholder]", async () => {
		const id = await productId(990001);
		const view = await Effect.runPromise(sellerMarketPrices(db, { viewer: seller, productId: id }));
		const asOf = Date.parse("2026-11-15T20:06:00Z");
		expect(view).toEqual({
			productId: id,
			tcgplayerProductId: 990001,
			prices: [
				{ subtype: "Foil", marketCents: 2503, asOf },
				{ subtype: "Normal", marketCents: 1240, asOf },
			],
			checkedAt: expect.any(Number),
		});
	});

	it("reports a subtype without a market price as null", async () => {
		const view = await Effect.runPromise(
			sellerMarketPrices(db, { viewer: seller, productId: await productId(990002) }),
		);
		expect(view.prices).toEqual([{ subtype: "Normal", marketCents: null, asOf: expect.any(Number) }]);
	});

	it("refuses anyone not acting as a seller [TCG-market-placeholder]", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const outcome = await exports.default.catalogMarketPrices({
			viewer: { userId: "u_buyer", canSell: false },
			productId: await productId(990001),
		});
		expect(outcome).toEqual({
			ok: false,
			error: { name: "MarketPriceForbidden", message: "Market prices are only shown to sellers" },
		});
		error.mockRestore();
	});

	it("fails for an unknown product", async () => {
		const outcome = await exports.default.catalogMarketPrices({ viewer: seller, productId: 999_999_999 });
		expect(outcome).toMatchObject({ ok: false, error: { message: "No catalog product 999999999" } });
	});
});

describe("catalog cron and RPC", () => {
	it("reads the per-run budget from config, with a default", () => {
		expect(groupsPerRun({ CATALOG_GROUPS_PER_RUN: "25" })).toBe(25);
		expect(groupsPerRun({ CATALOG_GROUPS_PER_RUN: "lots" })).toBe(300);
		expect(groupsPerRun({ CATALOG_GROUPS_PER_RUN: "-1" })).toBe(300);
	});

	it("is configured as a cron trigger", async () => {
		// The engine's wrangler.jsonc lists CATALOG_CRON; the scheduled handler dispatches on it.
		expect(CATALOG_CRON).toBe("15 0-2,21-23 * * *");
	});

	it("the ingestCatalog RPC runs one game against TCGCSV_BASE_URL [TCG-catalog-ingest]", async () => {
		const fake = fakeTcgCsv(env.TCGCSV_BASE_URL);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
		try {
			const outcome = await exports.default.ingestCatalog({ game: "riftbound", maxGroups: 5 });
			expect(outcome).toMatchObject({ ok: true, value: { groupsIngested: 2, groupsRemaining: 0 } });
			const invalid = await exports.default.ingestCatalog({ game: "riftbound", maxGroups: -1 });
			expect(invalid).toMatchObject({ ok: false, error: { name: "SchemaError" } });
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("the scheduled handler runs the ingestion for the catalog cron, and logs a run summary", async () => {
		const fake = fakeTcgCsv(env.TCGCSV_BASE_URL);
		// Only Riftbound is enabled here, so the run is small.
		await db.prepare("UPDATE games SET enabled = (id = 'riftbound')").run();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
		const log = quiet[0]!;
		try {
			const controller = createScheduledController({ scheduledTime: new Date(), cron: CATALOG_CRON });
			await new Engine(createExecutionContext(), env).scheduled(controller);
		} finally {
			fetchSpy.mockRestore();
		}
		const lines = log.mock.calls.map(
			(call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>,
		);
		expect(lines).toContainEqual(
			expect.objectContaining({
				msg: "catalog ingestion finished",
				service: "engine",
				groups_ingested: 2,
				products_written: 12,
				build: FIXTURE_BUILD,
			}),
		);
		expect(await count("catalog_products")).toBe(12);
	});
});
