import { describe, expect, it } from "vitest";
import { autofillForm, productKindFor } from "./catalog-autofill.ts";
import type { CatalogHit } from "./market.ts";

const blueEyes: CatalogHit = {
	productId: 7,
	tcgplayerProductId: 5001,
	game: "yugioh",
	kind: "single",
	name: "Blue-Eyes White Dragon",
	setName: "Legend of Blue Eyes White Dragon",
	setCode: "LOB",
	number: "LOB-001",
	rarity: "Ultra Rare",
	productType: null,
};

describe("autofillForm", () => {
	it("[TCG-autofill-only] sets the game and catalog attributes, keeping the seller's fields", () => {
		const form = {
			title: "",
			gameId: "pokemon",
			kind: "single",
			attributes: JSON.stringify({ number: "999", finish: "foil", altered: true }),
			price: "12.50",
			quantity: "2",
			condition: "LP",
		};
		const result = autofillForm(form, blueEyes);
		if (!result.ok) throw new Error(result.message);
		expect(result.value).toMatchObject({
			title: "Blue-Eyes White Dragon",
			gameId: "yugioh",
			price: "12.50",
			quantity: "2",
			condition: "LP",
		});
		expect(JSON.parse(result.value.attributes)).toEqual({
			finish: "foil",
			altered: true,
			name: "Blue-Eyes White Dragon",
			set_code: "LOB",
			set_name: "Legend of Blue Eyes White Dragon",
			number: "LOB-001",
			rarity: "Ultra Rare",
			tcgplayer_product_id: 5001,
		});
	});

	it("[TCG-autofill-only] never replaces a title the seller typed", () => {
		const result = autofillForm(
			{ title: "My BEWD", gameId: "yugioh", kind: "graded", attributes: "" },
			blueEyes,
		);
		expect(result).toMatchObject({ ok: true, value: { title: "My BEWD" } });
	});

	it("refuses accessories, lots and a product of the other kind", () => {
		expect(
			autofillForm({ title: "", gameId: "yugioh", kind: "lot", attributes: "" }, blueEyes),
		).toMatchObject({ ok: false });
		expect(
			autofillForm({ title: "", gameId: "yugioh", kind: "sealed", attributes: "" }, blueEyes),
		).toMatchObject({
			ok: false,
			message: "That catalog entry isn't a sealed product",
		});
		expect([productKindFor("graded"), productKindFor("sealed"), productKindFor("accessory")]).toEqual([
			"single",
			"sealed",
			null,
		]);
	});
});
