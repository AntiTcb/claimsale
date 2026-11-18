import { shareCard } from "@claimsale/core";
import { describe, expect, it } from "vitest";
import { plainShareCard, renderShareCard } from "./og-render.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: ArrayBuffer): [number, number] {
	const view = new DataView(png);
	return [view.getUint32(16), view.getUint32(20)];
}

const sale = { title: "Weekend Pokémon", sellerHandle: "misty", sellerDisplayName: "Misty", status: "live" };

describe("renderShareCard", () => {
	// The renderer loads satori's and resvg's WebAssembly on first use.
	it("renders a full card and a private card as 1200×630 PNGs", { timeout: 30_000 }, async () => {
		const full = shareCard({ ...sale, access: "ok" }, [
			{ title: "Charizard ex", priceCents: 4500, quantity: 1, unitsWon: 0, state: "available" },
			{ title: "Pikachu", priceCents: 500, quantity: 1, unitsWon: 1, state: "won" },
		]);
		const locked = shareCard({ ...sale, access: "locked" }, []);
		for (const card of [full, locked]) {
			const png = await renderShareCard(card);
			expect([...new Uint8Array(png.slice(0, 8))]).toEqual(PNG_SIGNATURE);
			expect(pngSize(png)).toEqual([1200, 630]);
		}
	});
});

describe("plainShareCard", () => {
	it("takes emoji out of every text on the card and nothing else", () => {
		const card = shareCard(
			{ ...sale, title: "🔥 Big   sale 🇺🇸 Pokémon ❤️", sellerDisplayName: "Misty 👩‍🎤", access: "ok" },
			[{ title: "Charizard 🐉 ex", priceCents: 4500, quantity: 1, unitsWon: 0, state: "available" }],
		);
		const plain = plainShareCard(card);
		expect([plain.title, plain.seller, plain.items[0]!.title]).toEqual([
			"Big sale Pokémon",
			"Misty (@misty)",
			"Charizard ex",
		]);
		expect(plain.items[0]!.price).toBe("$45.00");
	});
});
