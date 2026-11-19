import { createDb, type Db } from "@claimsale/db";
import { beforeEach, describe, expect, it } from "vitest";
import { D1_MAX_PARAMS, testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { loadControlRoom } from "./control-room.ts";
import { photosByItem } from "./images.ts";
import { addItem, itemsWithEntries, listItems, setPrices } from "./items.ts";
import { createDraft } from "./sales.ts";

/**
 * Pro sales have no item cap, so queries over a sale's items must not bind one parameter per
 * item: D1 refuses a statement with more than 100 (the staging load test found the sale page
 * failing with 120 items). The test database refuses them too.
 */

const ITEMS = 120;
const pro = { id: "seller", tier: "pro" as const };

let db: Db;
let saleId: string;
let itemIds: string[];

beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	const sale = await createDraft(
		db,
		pro,
		{ title: "Big sale", descriptionMd: "", visibility: "unlisted" },
		1,
	);
	if (!sale.ok) throw new Error("setup");
	saleId = sale.value.id;
	itemIds = [];
	for (let i = 0; i < ITEMS; i++) {
		// oxlint-disable-next-line no-await-in-loop -- sort order follows insertion
		const item = await addItem(
			db,
			pro,
			saleId,
			{
				title: `Card ${i}`,
				priceCents: 100,
				quantity: 1,
				gameId: "pokemon",
				kind: "single",
				condition: null,
				attributes: {},
			},
			1,
		);
		if (!item.ok) throw new Error(`setup: ${item.error.code}`);
		itemIds.push(item.value.id);
	}
});

describe(`a sale with ${ITEMS} items`, () => {
	it("the test database refuses more bound parameters than D1 allows", () => {
		const statement = testD1().prepare("SELECT 1");
		expect(() => statement.bind(...Array.from({ length: D1_MAX_PARAMS + 1 }, () => 1))).toThrow(
			/too many SQL variables/,
		);
	});

	it("loads its items, their photos and which have entries (the sale page, the item editor)", async () => {
		expect(await listItems(db, saleId)).toHaveLength(ITEMS);
		expect(await photosByItem(db, itemIds, "approved")).toEqual(new Map());
		expect(await itemsWithEntries(db, itemIds)).toEqual(new Set());
	});

	it("takes a bulk price change for every item", async () => {
		const changes = itemIds.map((itemId) => ({ itemId, priceCents: 250 }));
		expect(await setPrices(db, pro.id, saleId, changes, 2)).toEqual({ ok: true, value: { updated: ITEMS } });
	});

	it("opens in the control room", async () => {
		expect((await loadControlRoom(db, saleId)).items).toHaveLength(ITEMS);
	});
});
