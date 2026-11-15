import { describe, expect, it } from "vitest";
import {
	CONDITIONS,
	conditionAtLeast,
	enabledGames,
	FINISH_LABELS,
	GAMES,
	gameBySlug,
	LANGUAGE_LABELS,
	resolveGame,
} from "./games.ts";

describe("games registry", () => {
	it("has the launch games first: Pokémon, Yu-Gi-Oh!, MTG, Riftbound (D61)", () => {
		expect(
			enabledGames()
				.slice(0, 4)
				.map((game) => game.slug),
		).toEqual(["pokemon", "yugioh", "mtg", "riftbound"]);
	});

	it("has unique slugs, sort orders and category IDs, and only known finishes and languages", () => {
		expect(new Set(GAMES.map((g) => g.slug)).size).toBe(GAMES.length);
		expect(new Set(GAMES.map((g) => g.sortOrder)).size).toBe(GAMES.length);
		const ids = GAMES.map((g) => g.tcgplayerCategoryId).filter((id) => id !== null);
		expect(new Set(ids).size).toBe(ids.length);
		for (const game of GAMES) {
			expect(game.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
			expect(game.conditionScale).toEqual(CONDITIONS);
			expect(game.finishes.length).toBeGreaterThan(0);
			for (const finish of game.finishes) expect(FINISH_LABELS).toHaveProperty(finish);
			for (const language of game.languages) expect(LANGUAGE_LABELS).toHaveProperty(language);
		}
	});

	it("uses the well-known TCGplayer categories for MTG, YGO and Pokémon", () => {
		expect(gameBySlug("mtg")?.tcgplayerCategoryId).toBe(1);
		expect(gameBySlug("yugioh")?.tcgplayerCategoryId).toBe(2);
		expect(gameBySlug("pokemon")?.tcgplayerCategoryId).toBe(3);
	});

	it("resolves slugs, names, product lines and abbreviations, ignoring case and accents", () => {
		expect(resolveGame("Pokémon")?.slug).toBe("pokemon");
		expect(resolveGame("POKEMON")?.slug).toBe("pokemon");
		expect(resolveGame("YuGiOh")?.slug).toBe("yugioh");
		expect(resolveGame("ygo")?.slug).toBe("yugioh");
		expect(resolveGame("Magic")?.slug).toBe("mtg");
		expect(resolveGame("Magic: The Gathering")?.slug).toBe("mtg");
		expect(resolveGame("one piece card game")?.slug).toBe("one-piece");
		expect(resolveGame("")).toBeUndefined();
		expect(resolveGame("Hearthstone")).toBeUndefined();
	});

	it("orders conditions best first", () => {
		expect(conditionAtLeast("NM", "LP")).toBe(true);
		expect(conditionAtLeast("LP", "LP")).toBe(true);
		expect(conditionAtLeast("HP", "LP")).toBe(false);
	});
});
