import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	SHARE_CARD_ITEMS,
	shareCard,
	shareCardDescription,
	shareCardVersion,
	type ShareCardItem,
	type ShareCardSale,
} from "./share-card.ts";

const sale: ShareCardSale = {
	title: "Weekend YGO",
	sellerHandle: "misty",
	sellerDisplayName: "Misty",
	status: "scheduled",
	access: "ok",
};
const item = (over: Partial<ShareCardItem> = {}): ShareCardItem => ({
	title: "Blue-Eyes White Dragon",
	priceCents: 4000,
	quantity: 1,
	unitsWon: 0,
	state: "available",
	...over,
});

describe("shareCard", () => {
	it("lists available items first, counts the rest and leaves withdrawn ones out", () => {
		const card = shareCard(sale, [
			item({ title: "Sold", unitsWon: 1, state: "won" }),
			item({ title: "Gone", state: "withdrawn" }),
			...Array.from({ length: 5 }, (_, i) => item({ title: `Card ${i + 1}`, priceCents: 100 * (i + 1) })),
		]);
		expect(card.itemCount).toBe(6);
		expect(card.items).toEqual([
			{ title: "Card 1", price: "$1.00", soldOut: false },
			{ title: "Card 2", price: "$2.00", soldOut: false },
			{ title: "Card 3", price: "$3.00", soldOut: false },
		]);
		expect(card.more).toBe(3);
		expect([card.seller, card.status, card.private]).toEqual(["Misty (@misty)", "upcoming", false]);
	});

	it("marks sold-out items once the available ones run out", () => {
		const card = shareCard({ ...sale, status: "live", sellerDisplayName: null }, [
			item({ title: "Sold", quantity: 2, unitsWon: 2 }),
			item({ title: "Open" }),
		]);
		expect(card.items.map((i) => [i.title, i.soldOut])).toEqual([
			["Open", false],
			["Sold", true],
		]);
		expect([card.seller, card.status, card.more]).toEqual(["@misty", "live", 0]);
		expect(shareCard({ ...sale, sellerHandle: null }, []).seller).toBe("Misty");
	});

	it("[SHARE-private-title-only] a private sale's card shows only its title, seller and status", () => {
		const card = shareCard({ ...sale, access: "locked", status: "closed" }, [item(), item()]);
		expect(card).toEqual({
			title: "Weekend YGO",
			seller: "Misty (@misty)",
			status: "closed",
			private: true,
			itemCount: 0,
			items: [],
			more: 0,
		});
		const description = shareCardDescription(card);
		expect(description).toBe("A private sale by Misty (@misty) on ClaimSale. Closed.");
		expect(description).not.toContain("item");
	});

	it("[SHARE-private-title-only] never puts an item of a locked sale on the card", () => {
		fc.assert(
			fc.property(fc.array(fc.string({ minLength: 1 }), { maxLength: 8 }), (titles) => {
				const card = shareCard(
					{ ...sale, access: "locked" },
					titles.map((title) => item({ title })),
				);
				expect([card.items.length, card.itemCount, card.more]).toEqual([0, 0, 0]);
			}),
		);
	});

	it("shortens long titles with an ellipsis and folds whitespace", () => {
		const card = shareCard({ ...sale, title: `  Big\n\nsale ${"x".repeat(200)}` }, [
			item({ title: "y".repeat(100) }),
		]);
		expect(card.title).toHaveLength(90);
		expect(card.title.startsWith("Big sale x")).toBe(true);
		expect(card.title.endsWith("…")).toBe(true);
		expect(card.items[0]!.title).toHaveLength(48);
	});

	it("caps the card at a fixed number of items", () => {
		fc.assert(
			fc.property(fc.nat({ max: 30 }), (n) => {
				const card = shareCard(
					sale,
					Array.from({ length: n }, () => item()),
				);
				expect(card.items.length).toBe(Math.min(n, SHARE_CARD_ITEMS));
				expect(card.items.length + card.more).toBe(n);
			}),
		);
	});
});

describe("shareCardVersion", () => {
	it("[SHARE-cache-version] is the same for the same card and changes when the card does", () => {
		const card = shareCard(sale, [item()]);
		expect(shareCardVersion(shareCard(sale, [item()]))).toBe(shareCardVersion(card));
		const changes = [
			shareCard({ ...sale, title: "Weekend YGO!" }, [item()]),
			shareCard({ ...sale, status: "live" }, [item()]),
			shareCard(sale, [item({ priceCents: 4001 })]),
			shareCard(sale, [item({ unitsWon: 1 })]),
			shareCard(sale, [item(), item()]),
			shareCard({ ...sale, access: "locked" }, [item()]),
		];
		const versions = new Set([card, ...changes].map(shareCardVersion));
		expect(versions.size).toBe(changes.length + 1);
		expect(shareCardVersion(card)).toMatch(/^[0-9a-z]+$/);
	});

	it("ignores what isn't on the card", () => {
		const items = Array.from({ length: SHARE_CARD_ITEMS + 2 }, (_, i) => item({ title: `Card ${i}` }));
		const edited = items.map((x, i) => (i === items.length - 1 ? { ...x, priceCents: 9999 } : x));
		expect(shareCardVersion(shareCard(sale, edited))).toBe(shareCardVersion(shareCard(sale, items)));
	});
});

describe("shareCardDescription", () => {
	it("says how many items, from whom, and the status", () => {
		expect(shareCardDescription(shareCard(sale, [item()]))).toBe(
			"1 item from Misty (@misty). Upcoming. Claim on ClaimSale.",
		);
		expect(shareCardDescription(shareCard({ ...sale, status: "live" }, [item(), item()]))).toBe(
			"2 items from Misty (@misty). Live now. Claim on ClaimSale.",
		);
	});
});
