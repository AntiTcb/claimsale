import { describe, expect, it } from "vitest";
import {
	attributeFields,
	certificateUrl,
	coerceAttribute,
	coerceAttributes,
	formatAttribute,
	GRADES,
	ITEM_KINDS,
	validateAttributes,
} from "./attributes.ts";
import { GAMES, gameBySlug, type Game } from "./games.ts";
import { expectOk } from "./testing.ts";

const game = (slug: string): Game => gameBySlug(slug)!;
const keys = (slug: string) => attributeFields("single", game(slug)).map((f) => f.key);
const issuesOf = (result: ReturnType<typeof validateAttributes>) => (result.ok ? [] : result.error);

describe("attribute schemas [TCG-attribute-schema]", () => {
	it("accepts a complete Pokémon single [TCG-attribute-schema]", () => {
		const value = expectOk(
			validateAttributes("single", game("pokemon"), {
				name: "Charizard ex",
				set_code: "OBF",
				number: "125/197",
				condition: "NM",
				finish: "holo",
				edition: "1st-edition",
				language: "en",
				altered: false,
			}),
		);
		expect(value["condition"]).toBe("NM");
	});

	it("requires the card name and condition on a single [TCG-attribute-schema]", () => {
		const issues = issuesOf(validateAttributes("single", game("mtg"), {}));
		expect(issues.map((i) => i.field).toSorted()).toEqual(["condition", "name"]);
		expect(issues.find((i) => i.field === "condition")?.message).toBe("Condition is required");
	});

	it("rejects values outside the game's options with a readable message [TCG-attribute-schema]", () => {
		const issues = issuesOf(
			validateAttributes("single", game("mtg"), { name: "Sol Ring", condition: "Mint", finish: "holo" }),
		);
		expect(issues).toContainEqual({
			field: "condition",
			message: "Condition must be one of: NM, LP, MP, HP, DMG",
		});
		expect(issues).toContainEqual({
			field: "finish",
			message: "Finish must be one of: non-foil, foil, etched",
		});
	});

	it("rejects fields from another game or kind [TCG-attribute-schema]", () => {
		// "treatment" is an MTG field; "grader" belongs to graded singles.
		const issues = issuesOf(
			validateAttributes("single", game("pokemon"), {
				name: "Pikachu",
				condition: "NM",
				treatment: "showcase",
				grader: "PSA",
			}),
		);
		expect(issues.map((i) => i.field).toSorted()).toEqual(["grader", "treatment"]);
	});

	it("has the game-specific single fields from the PLAN table [TCG-attribute-schema]", () => {
		expect(keys("yugioh")).toEqual(expect.arrayContaining(["edition", "print_region", "altered"]));
		expect(keys("pokemon")).toEqual(expect.arrayContaining(["edition", "promo_stamp"]));
		expect(keys("mtg")).toContain("treatment");
		expect(keys("riftbound")).toContain("variant");
		expect(keys("lorcana")).not.toContain("treatment");
	});

	it("requires grader, grade and cert number on graded singles [TCG-attribute-schema]", () => {
		const issues = issuesOf(validateAttributes("graded", game("pokemon"), { name: "Umbreon VMAX" }));
		expect(issues.map((i) => i.field).toSorted()).toEqual(["cert_number", "grade", "grader"]);
		expectOk(
			validateAttributes("graded", game("pokemon"), {
				name: "Umbreon VMAX",
				grader: "PSA",
				grade: "9.5",
				cert_number: "87654321",
			}),
		);
		const bad = issuesOf(
			validateAttributes("graded", game("pokemon"), {
				name: "Umbreon",
				grader: "PSA",
				grade: "11",
				cert_number: "no spaces!",
			}),
		);
		expect(bad.map((i) => i.field).toSorted()).toEqual(["cert_number", "grade"]);
		expect(GRADES).toContain("Authentic");
		expect(GRADES).toContain("1");
	});

	it("validates sealed, accessory and lot attributes [TCG-attribute-schema]", () => {
		expectOk(
			validateAttributes("sealed", game("pokemon"), { name: "Obsidian Flames Booster Box", repack: false }),
		);
		expectOk(validateAttributes("accessory", null, { accessory_type: "playmat", condition: "new" }));
		expectOk(validateAttributes("lot", game("yugioh"), { card_count: 500 }));
		expect(issuesOf(validateAttributes("lot", game("yugioh"), { card_count: 0 }))).toEqual([
			{ field: "card_count", message: "Card count must be a whole number from 1 to 1000000" },
		]);
		expect(issuesOf(validateAttributes("lot", game("yugioh"), { card_count: 2.5 }))[0]?.field).toBe(
			"card_count",
		);
	});

	it("needs a game for every kind except accessories [TCG-attribute-schema]", () => {
		expect(issuesOf(validateAttributes("single", null, {}))).toEqual([
			{ field: "game", message: "A single needs a game" },
		]);
	});

	it("rejects untrimmed and over-long text [TCG-attribute-schema]", () => {
		const issues = issuesOf(
			validateAttributes("single", game("mtg"), {
				name: " Sol Ring",
				condition: "NM",
				set_code: "X".repeat(33),
			}),
		);
		expect(issues.map((i) => i.field).toSorted()).toEqual(["name", "set_code"]);
	});

	it("builds a schema for every game × kind [TCG-attribute-schema]", () => {
		for (const g of GAMES) {
			for (const kind of ITEM_KINDS) expect(attributeFields(kind, g).length).toBeGreaterThan(0);
		}
	});
});

describe("attribute coercion from import cells", () => {
	const fields = attributeFields("single", game("pokemon"));
	const spec = (key: string) => fields.find((f) => f.key === key)!;

	it("maps labels and other apps' spellings onto options", () => {
		expect(coerceAttribute(spec("condition"), "Near Mint")).toBe("NM");
		expect(coerceAttribute(spec("condition"), "lightly_played")).toBe("LP");
		expect(coerceAttribute(spec("condition"), "nm")).toBe("NM");
		expect(coerceAttribute(spec("finish"), "Reverse Holofoil")).toBe("reverse-holo");
		expect(coerceAttribute(spec("edition"), "1st Edition")).toBe("1st-edition");
		expect(coerceAttribute(spec("language"), "English")).toBe("en");
	});

	it("only maps finish aliases onto the game's own finishes", () => {
		const mtgFinish = attributeFields("single", game("mtg")).find((f) => f.key === "finish")!;
		expect(coerceAttribute(mtgFinish, "normal")).toBe("non-foil");
		const ygoFinish = attributeFields("single", game("yugioh")).find((f) => f.key === "finish")!;
		expect(coerceAttribute(ygoFinish, "normal")).toBe("normal");
	});

	it("reads booleans and integers, leaving junk for the schema to reject", () => {
		expect(coerceAttribute(spec("altered"), "Yes")).toBe(true);
		expect(coerceAttribute(spec("altered"), "0")).toBe(false);
		expect(coerceAttribute(spec("altered"), "maybe")).toBe("maybe");
		expect(coerceAttribute(spec("tcgplayer_product_id"), "509876")).toBe(509876);
		expect(coerceAttribute(spec("tcgplayer_product_id"), "12a")).toBe("12a");
		expect(coerceAttributes(fields, { name: "  Pikachu ", condition: "", unknown: "x" })).toEqual({
			name: "Pikachu",
		});
	});

	it("formats values so coercion reads them back", () => {
		for (const value of [true, false, 42, "NM", 'Charizard, "ex"']) {
			const field =
				typeof value === "boolean"
					? spec("altered")
					: typeof value === "number"
						? spec("tcgplayer_product_id")
						: spec("name");
			expect(coerceAttribute(field, formatAttribute(value))).toBe(value);
		}
	});
});

describe("grader certificate links", () => {
	it("links known graders and refuses odd cert numbers", () => {
		expect(certificateUrl("PSA", "12345678")).toBe("https://www.psacard.com/cert/12345678");
		expect(certificateUrl("other", "12345678")).toBeNull();
		expect(certificateUrl("PSA", "../evil")).toBeNull();
	});
});
