import { createDb, eq, sql, type Db } from "@claimsale/db";
import { items, sales } from "@claimsale/db/schema";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import type { SessionUser } from "./auth.ts";

// The routes read bindings through context.ts; here they get a
// real schema on node:sqlite and a fake engine instead.
let database: Db;
const searchCatalog = vi.fn<(input: unknown) => Promise<unknown>>();
const applyImportBatch = vi.fn<(input: Record<string, unknown>) => Promise<unknown>>();
const listingsChanged = vi.fn<(input: { saleId: string; sellerId: string }) => Promise<unknown>>(
	async () => ({
		ok: true,
		value: true,
	}),
);
let deletedKeys: string[] = [];
const refuse = (code: string) =>
	applyImportBatch.mockResolvedValue({ ok: true, value: { ok: false, error: { code, message: "No" } } });
vi.mock("#lib/server/context.ts", () => ({
	db: () => database,
	imageStore: () => ({
		delete: async (keys: string[]) => {
			deletedKeys.push(...keys);
		},
	}),
	engineRpc: () => ({ searchCatalog, applyImportBatch }),
	notifyRpc: () => ({ listingsChanged }),
}));
// The Worker runtime (tracing, error reports) needs workerd; the routes' effects run plainly here.
vi.mock("#lib/server/runtime.ts", () => ({
	runExit: (_name: string, effect: Effect.Effect<unknown>) => Effect.runPromiseExit(effect),
}));

const { createDraft } = await import("./sales.ts");
const { addItem } = await import("./items.ts");
const apply = await import("../../routes/sell/[saleId]/import/apply/+server.ts");
const match = await import("../../routes/sell/[saleId]/import/match/+server.ts");
const market = await import("../../routes/sell/[saleId]/catalog/market/+server.ts");
const search = await import("../../routes/sell/[saleId]/catalog/search/+server.ts");
const importPage = await import("../../routes/sell/[saleId]/import/+page.server.ts");
const itemsPage = await import("../../routes/sell/[saleId]/items/+page.server.ts");
const settings = await import("../../routes/me/settings/+page.server.ts");

const user = (id: string, overrides: Partial<SessionUser> = {}): SessionUser => ({
	id,
	email: `${id}@example.test`,
	name: `User ${id}`,
	createdAt: new Date("2026-11-01T00:00:00Z"),
	updatedAt: new Date("2026-11-01T00:00:00Z"),
	emailVerified: true,
	ageAttested: "18+",
	phoneVerifiedAt: new Date("2026-11-14T00:00:00Z"),
	...overrides,
});

let saleId: string;
let otherSaleId: string;

function event(
	who: SessionUser | null,
	path: string,
	init: {
		method?: string;
		json?: unknown;
		form?: Record<string, string>;
		params?: Record<string, string>;
	} = {},
) {
	const url = new URL(`http://x${path}`);
	const body =
		init.json !== undefined
			? JSON.stringify(init.json)
			: init.form
				? Object.entries(init.form).reduce((data, [k, v]) => (data.append(k, v), data), new FormData())
				: undefined;
	return {
		locals: { user: who, session: null },
		url,
		params: init.params ?? { saleId },
		request: new Request(url, {
			method: init.method ?? (body === undefined ? "GET" : "POST"),
			...(body === undefined ? {} : { body }),
			...(init.json !== undefined ? { headers: { "content-type": "application/json" } } : {}),
		}),
		cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
		setHeaders: () => undefined,
		parent: async () => ({}),
	} as never;
}

const batch = (rows: Record<string, string>[]) => ({
	importId: "0190a000-0000-7000-8000-00000000000a",
	format: "csv",
	totalRows: rows.length,
	rows: rows.map((cells, i) => ({ row: i + 2, cells })),
});
const marketGet = (who: SessionUser | null, params?: Record<string, string>, product = "1") =>
	market.GET(event(who, `/sell/x/catalog/market?product=${product}`, params ? { params } : {}));
const hit = (kind: "single" | "sealed", id: number) => ({ productId: id, kind, name: `P${id}` });
const bulk = (changes: string) =>
	itemsPage.actions.bulkPrice!(event(user("u1"), `/sell/${saleId}/items?/bulkPrice`, { form: { changes } }));
const card = { game: "pokemon", kind: "single", name: "Charizard ex", condition: "NM", price: "12" };

beforeEach(async () => {
	database = createDb(testD1());
	await addUser(database, "u1");
	await addUser(database, "u2");
	const mine = await createDraft(
		database,
		{ id: "u1", tier: "free" },
		{ title: "Mine", descriptionMd: "", visibility: "unlisted" },
		1,
	);
	const theirs = await createDraft(
		database,
		{ id: "u2", tier: "free" },
		{ title: "Theirs", descriptionMd: "", visibility: "unlisted" },
		1,
	);
	if (!mine.ok || !theirs.ok) throw new Error("setup");
	saleId = mine.value.id;
	otherSaleId = theirs.value.id;
	await database.run(sql`INSERT INTO catalog_sets (id, game_id, code, name, tcgplayer_group_id, updated_at)
		VALUES (1, 'pokemon', 'OBF', 'Obsidian Flames', 100, 1)`);
	await database.run(sql`INSERT INTO catalog_products (id, game_id, set_id, kind, name, number, rarity, tcgplayer_product_id, updated_at)
		VALUES (1, 'pokemon', 1, 'single', 'Charizard ex', '125/197', 'Double Rare', 9001, 1)`);
	await database.run(
		sql`INSERT INTO market_prices (product_id, subtype, market_cents, as_of) VALUES (1, 'Holofoil', 1240, 10)`,
	);
	searchCatalog.mockReset();
	applyImportBatch.mockReset();
	deletedKeys = [];
});

describe("import endpoints", () => {
	it("[IO-import-validate] the apply endpoint gates the seller, decodes the batch and hands it to the engine", async () => {
		const post = (who: SessionUser | null, body: unknown, params?: Record<string, string>) =>
			apply.POST(event(who, `/sell/${saleId}/import/apply`, { json: body, ...(params ? { params } : {}) }));
		expect((await post(null, batch([card]))).status).toBe(401);
		expect((await post(user("u1", { emailVerified: false }), batch([card]))).status).toBe(403);
		expect((await post(user("u1"), batch([card]), { saleId: otherSaleId })).status).toBe(404);
		expect((await post(user("u1"), { ...batch([card]), importId: "nope" })).status).toBe(400);
		const tooMany = { ...batch([card]), rows: Array.from({ length: 101 }, () => ({ row: 2, cells: {} })) };
		expect((await post(user("u1"), tooMany)).status).toBe(400);
		expect(applyImportBatch).not.toHaveBeenCalled();

		const rows = [{ row: 2, outcome: "created", itemId: "i1", field: "", message: "" }];
		applyImportBatch.mockResolvedValue({
			ok: true,
			value: { ok: true, value: { rows, removed: 1, removedR2Keys: ["photos/x.webp"] } },
		});
		const response = await post(user("u1"), batch([card]));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ rows, removed: 1 });
		expect(applyImportBatch).toHaveBeenCalledWith({ saleId, sellerId: "u1", ...batch([card]) });
		expect(deletedKeys).toEqual(["photos/x.webp"]);

		applyImportBatch.mockResolvedValueOnce({ ok: false, error: { name: "E", message: "x" } });
		expect((await post(user("u1"), batch([card]))).status).toBe(503);
	});

	it("[IO-import-target] the engine's refusal reaches the browser as 409, and the page says why", async () => {
		const post = () => apply.POST(event(user("u1"), `/sell/${saleId}/import/apply`, { json: batch([card]) }));
		refuse("sale_not_importable");
		const response = await post();
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ code: "sale_not_importable", message: "No" });
		refuse("batch_too_large");
		expect((await post()).status).toBe(400);
		await database.update(sales).set({ status: "live" }).where(eq(sales.id, saleId));
		const page = (await importPage.load(event(user("u1"), `/sell/${saleId}/import`))) as {
			importable: string | null;
		};
		expect(page.importable).toMatch(/draft or scheduled/);
	});

	it("[TCG-catalog-match] the match endpoint returns each row's match with the seller's market prices", async () => {
		const response = await match.POST(
			event(user("u1"), `/sell/${saleId}/import/match`, {
				json: {
					rows: [
						{ row: 2, game: "pokemon", kind: "single", attributes: { set_code: "OBF", number: "125/197" } },
						{ row: 3, game: "pokemon", kind: "single", attributes: { name: "Mew" } },
					],
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			matches: [
				{
					row: 2,
					status: "matched",
					product: expect.objectContaining({ productId: 1, tcgplayerProductId: 9001 }),
				},
				{ row: 3, status: "unmatched" },
			],
			prices: { "1": [{ subtype: "Holofoil", marketCents: 1240, asOf: 10 }] },
		});
		const bad = await match.POST(
			event(user("u1"), `/sell/${saleId}/import/match`, { json: { rows: [{ row: 2 }] } }),
		);
		expect(bad.status).toBe(400);
	});

	it("[TCG-market-placeholder] market prices go only to the seller of the sale", async () => {
		expect((await marketGet(null)).status).toBe(401);
		expect((await marketGet(user("u2", { phoneVerifiedAt: null }))).status).toBe(403);
		expect((await marketGet(user("u2"))).status).toBe(404); // u2 isn't this sale's seller
		expect((await marketGet(user("u1"), undefined, "abc")).status).toBe(400);
		const own = await marketGet(user("u1"));
		expect(own.headers.get("cache-control")).toBe("private, no-store");
		expect(await own.json()).toEqual({
			prices: [{ subtype: "Holofoil", marketCents: 1240, asOf: 10 }],
			defaultPercent: null,
		});
	});

	it("searches the catalog through the engine, narrowed to the item's kind", async () => {
		searchCatalog.mockResolvedValue({ ok: true, value: [hit("single", 1), hit("sealed", 2)] });
		const get = (query: string) => search.GET(event(user("u1"), `/sell/${saleId}/catalog/search?${query}`));
		const sealed = await get("q=char&kind=sealed&game=pokemon");
		expect(await sealed.json()).toEqual({ hits: [hit("sealed", 2)] });
		expect(searchCatalog).toHaveBeenCalledWith({ query: "char", game: "pokemon", limit: 25 });
		expect(await (await get("q=c&kind=single")).json()).toEqual({ hits: [] });
		expect(await (await get("q=char&kind=lot")).json()).toEqual({ hits: [] });
		searchCatalog.mockRejectedValue(new Error("no engine"));
		expect((await get("q=char")).status).toBe(503);
		searchCatalog.mockResolvedValue({ ok: false, error: { name: "E", message: "x" } });
		expect((await get("q=char")).status).toBe(503);
		expect((await search.GET(event(null, `/sell/${saleId}/catalog/search?q=char`))).status).toBe(401);
	});
});

describe("bulk % of market and the default %", () => {
	it("[TCG-market-pct] applies the confirmed preview's prices; [SM-2-lock-price-qty] locked items refuse", async () => {
		const add = async (title: string) => {
			const added = await addItem(
				database,
				{ id: "u1", tier: "free" },
				saleId,
				{
					title,
					priceCents: 100,
					quantity: 1,
					gameId: "pokemon",
					kind: "single",
					condition: "NM",
					attributes: {},
				},
				1,
			);
			if (!added.ok) throw new Error("setup");
			return added.value.id;
		};
		const a = await add("A");
		const b = await add("B");
		expect(await bulk(`${a}:975,${b}:850`)).toEqual({ action: "bulkPrice", updated: 2 });
		// Drafts too: the sale's engine keeps its own copy of the items (SM-9-local-store).
		expect(listingsChanged).toHaveBeenLastCalledWith({ saleId, sellerId: "u1" });
		const prices = await database.select({ id: items.id, price: items.priceCents }).from(items).all();
		expect(new Map(prices.map((p) => [p.id, p.price]))).toEqual(
			new Map([
				[a, 975],
				[b, 850],
			]),
		);
		expect(await bulk(`${a}:0`)).toMatchObject({ status: 400 });
		expect(await bulk(`nope:500`)).toMatchObject({ status: 400 });

		await database.run(
			sql`INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('b', 'b@x.test', 'B', 1, 1)`,
		);
		await database.run(
			sql`INSERT INTO entries (id, item_id, user_id, kind, amount_cents, status, created_at) VALUES ('e1', ${a}, 'b', 'claim', 975, 'open', 1)`,
		);
		expect(await bulk(`${a}:500`)).toMatchObject({
			status: 400,
			data: { errors: { form: expect.stringMatching(/locked/) } },
		});
	});

	it("saves the seller's default % in settings", async () => {
		const save = (percent: string) =>
			settings.actions.marketPct!(event(user("u1"), "/me/settings?/marketPct", { form: { percent } }));
		expect(await save("85")).toEqual({ action: "marketPct", saved: true });
		const page = (await itemsPage.load(event(user("u1"), `/sell/${saleId}/items`))) as {
			defaultPercent: number | null;
		};
		expect(page.defaultPercent).toBe(85);
		expect(await save("33")).toMatchObject({ status: 400 });
		expect(await save("")).toEqual({ action: "marketPct", saved: true });
	});
});
