import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GAMES } from "@claimsale/core";
import { createDb } from "@claimsale/db";
import { describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { GAMES as FORM_GAMES, type ItemFields } from "#lib/listing-input.ts";
import { addItem } from "./items.ts";
import { createDraft } from "./sales.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../../../packages/db/migrations");
const seller = { id: "seller", tier: "pro" as const };
const card: ItemFields = {
	title: "Black Lotus",
	priceCents: 4000,
	quantity: 1,
	gameId: "mtg",
	kind: "single",
	condition: "LP",
	attributes: {},
};

interface GameRow {
	id: string;
	slug: string;
	name: string;
	condition_scale: string;
	finishes: string;
	languages: string;
	tcgplayer_category_id: number | null;
	enabled: number;
	sort_order: number;
}

// Catalog ingestion and search (engine) read the `games` table; the sell form and the
// attribute schemas read the core registry. Migrations 0004 and 0005 make the table
// match the registry, so a registry change needs a migration that changes the rows.
describe("games table and registry", () => {
	it("has one row per registry game, with the same fields", async () => {
		const { results } = await testD1()
			.prepare("SELECT * FROM games WHERE id <> 'pokemon-japan' ORDER BY sort_order")
			.all<GameRow>();
		expect(
			results.map((row) => ({
				slug: row.slug,
				name: row.name,
				conditionScale: JSON.parse(row.condition_scale),
				finishes: JSON.parse(row.finishes),
				languages: JSON.parse(row.languages),
				tcgplayerCategoryId: row.tcgplayer_category_id,
				enabled: row.enabled === 1,
				sortOrder: row.sort_order,
				idIsSlug: row.id === row.slug,
			})),
		).toEqual(
			GAMES.toSorted((a, b) => a.sortOrder - b.sortOrder).map((game) => ({
				slug: game.slug,
				name: game.name,
				conditionScale: [...game.conditionScale],
				finishes: [...game.finishes],
				languages: [...game.languages],
				tcgplayerCategoryId: game.tcgplayerCategoryId,
				enabled: game.enabled,
				sortOrder: game.sortOrder,
				idIsSlug: true,
			})),
		);
	});

	// Japanese Pokémon is a language of `pokemon`; the row only marks TCGCSV's separate
	// category for later ingestion, so it must never be enabled as a game of its own.
	it("keeps the extra pokemon-japan row disabled and out of the registry", async () => {
		const row = await testD1().prepare("SELECT * FROM games WHERE id = 'pokemon-japan'").first<GameRow>();
		expect(row).toMatchObject({ enabled: 0, tcgplayer_category_id: 85 });
		expect(GAMES.some((game) => game.slug === "pokemon-japan")).toBe(false);
	});

	it("gives every enabled game a TCGplayer category, so ingestion can read it", async () => {
		const { results } = await testD1()
			.prepare("SELECT slug FROM games WHERE enabled = 1 AND tcgplayer_category_id IS NULL")
			.all<{ slug: string }>();
		expect(results).toEqual([]);
	});

	it("offers the sell form only games with a row (no 'Other TCG')", async () => {
		const { results } = await testD1()
			.prepare("SELECT id FROM games WHERE enabled = 1")
			.all<{ id: string }>();
		const seeded = new Set(results.map((row) => row.id));
		expect(FORM_GAMES.map((g) => g.id).filter((id) => !seeded.has(id))).toEqual([]);
	});

	it("moves items stored under the old 'magic' id to the registry slug 'mtg', and reruns safely", async () => {
		const d1 = testD1();
		const db = createDb(d1);
		await addUser(db, "seller");
		const sale = await createDraft(
			db,
			seller,
			{ title: "Sale", descriptionMd: "", visibility: "unlisted" },
			1,
		);
		if (!sale.ok) throw new Error("setup");
		for (const gameId of ["magic", "yugioh"]) {
			const item = await addItem(db, seller, sale.value.id, { ...card, gameId }, 2);
			if (!item.ok) throw new Error("setup");
		}
		// Rerunning the whole migration also proves the seed is safe to apply twice.
		const migration = readFileSync(join(MIGRATIONS, "0005_games_registry.sql"), "utf8");
		await d1.batch(
			migration
				.split("--> statement-breakpoint")
				.filter((statement) => statement.trim())
				.map((statement) => d1.prepare(statement)),
		);
		const { results } = await d1
			.prepare("SELECT game_id FROM items ORDER BY sort_order")
			.all<{ game_id: string }>();
		expect(results.map((row) => row.game_id)).toEqual(["mtg", "yugioh"]);
		const count = await d1.prepare("SELECT count(*) AS n FROM games").first<{ n: number }>();
		expect(count?.n).toBe(GAMES.length + 1); // + pokemon-japan
	});
});
