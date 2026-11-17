import { describe, expect, it } from "vitest";
import { gameBySlug } from "../games.ts";
import { ATTRIBUTE_KEYS, CORE_COLUMNS, TEMPLATE_VERSION, templateColumns, templateRows } from "./columns.ts";

describe("import templates [TCG-attribute-schema]", () => {
	it("has the core columns, the kind's attribute columns and the template version [TCG-attribute-schema]", () => {
		const headers = templateColumns("graded", gameBySlug("pokemon")!).map((c) => c.header);
		expect(headers.slice(0, CORE_COLUMNS.length)).toEqual(CORE_COLUMNS.map((c) => c.header));
		expect(headers).toEqual(expect.arrayContaining(["grader", "grade", "cert_number", "edition"]));
		expect(headers.at(-1)).toBe("template_version");
	});

	it("leaves the game blank in an accessory template without a game [TCG-attribute-schema]", () => {
		const [headers, example] = templateRows("accessory", null);
		const row = Object.fromEntries(headers!.map((h, i) => [h, example![i]]));
		expect(row).toMatchObject({
			game: "",
			kind: "accessory",
			title: "Example listing title",
			template_version: String(TEMPLATE_VERSION),
		});
	});

	it("knows every attribute key once [TCG-attribute-schema]", () => {
		expect(new Set(ATTRIBUTE_KEYS).size).toBe(ATTRIBUTE_KEYS.length);
		expect(ATTRIBUTE_KEYS).toEqual(
			expect.arrayContaining(["condition", "treatment", "card_count", "accessory_type"]),
		);
	});
});
