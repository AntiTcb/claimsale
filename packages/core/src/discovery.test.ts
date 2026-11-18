import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	isDiscoverable,
	itemFiltersQuery,
	parseDollars,
	parseItemFilters,
	saleAsText,
	searchTerms,
	type TextExportItem,
} from "./discovery.ts";

/** A minimal URLSearchParams reader (core has no DOM or Node types). */
const params = (query: string) => {
	const pairs = query
		.split("&")
		.filter(Boolean)
		.map((pair) => pair.split("=").map((part) => decodeURIComponent(part.replaceAll("+", " "))));
	return {
		get: (name: string) => pairs.find(([k]) => k === name)?.[1] ?? null,
		getAll: (name: string) => pairs.filter(([k]) => k === name).map(([, v]) => v ?? ""),
	};
};

describe("discoverable sales", () => {
	it("[DISC-public-only] lists public sales that are scheduled or live, nothing else", () => {
		const statuses = ["draft", "scheduled", "live", "closed", "archived", "deleted"];
		for (const visibility of ["public", "unlisted", "private"]) {
			for (const status of statuses) {
				expect(isDiscoverable({ visibility, status })).toBe(
					visibility === "public" && (status === "scheduled" || status === "live"),
				);
			}
		}
	});
});

describe("browse filters", () => {
	it("reads the filters from a URL and drops what it doesn't understand", () => {
		expect(
			parseItemFilters(
				params(
					"kind=graded&condition=NM&condition=LP&condition=MINT&condition=NM&set=%20Obsidian%20Flames%20&min=5&max=$1,200.5&sort=price_asc&page=3",
				),
			),
		).toEqual({
			kind: "graded",
			conditions: ["NM", "LP"],
			set: "Obsidian Flames",
			rarity: null,
			language: null,
			finish: null,
			minCents: 500,
			maxCents: 120050,
			sort: "price_asc",
			page: 3,
		});
		expect(parseItemFilters(params("kind=box&sort=random&page=-2&min=abc"))).toMatchObject({
			kind: null,
			sort: "ending",
			page: 1,
			minCents: null,
		});
		// A reversed range is swapped, and the page is capped.
		expect(parseItemFilters(params("min=50&max=10&page=9999"))).toMatchObject({
			minCents: 1000,
			maxCents: 5000,
			page: 50,
		});
	});

	it("parses dollar amounts into integer cents", () => {
		expect(parseDollars("12")).toBe(1200);
		expect(parseDollars("0.5")).toBe(50);
		expect(parseDollars("$1,000.05")).toBe(100005);
		expect(parseDollars("1.234")).toBeNull();
		expect(parseDollars("-1")).toBeNull();
		expect(parseDollars("")).toBeNull();
		expect(parseDollars("1000000")).toBeNull();
	});

	it("writes filters back to a short query that reads the same", () => {
		const filters = parseItemFilters(
			params("kind=single&condition=LP&rarity=Rare&min=2.5&sort=newest&page=2"),
		);
		const query = itemFiltersQuery(filters);
		expect(query).toBe("?kind=single&condition=LP&rarity=Rare&min=2.50&sort=newest&page=2");
		expect(parseItemFilters(params(query.slice(1)))).toEqual(filters);
		expect(itemFiltersQuery(parseItemFilters(params("")))).toBe("");
		expect(itemFiltersQuery(filters, { page: 1, rarity: null })).toBe(
			"?kind=single&condition=LP&min=2.50&sort=newest",
		);
	});

	it("round-trips any filters through the URL", () => {
		const cents = fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null });
		fc.assert(
			fc.property(fc.record({ min: cents, max: cents, page: fc.integer({ min: 1, max: 50 }) }), (f) => {
				const filters = parseItemFilters(
					params(
						itemFiltersQuery(parseItemFilters(params("")), {
							minCents: f.min,
							maxCents: f.max,
							page: f.page,
						}).slice(1),
					),
				);
				const [lo, hi] = f.min !== null && f.max !== null && f.min > f.max ? [f.max, f.min] : [f.min, f.max];
				expect([filters.minCents, filters.maxCents, filters.page]).toEqual([lo, hi, f.page]);
			}),
		);
	});

	it("splits a search into words, ignoring accents, case and punctuation", () => {
		expect(searchTerms("Pokémon  CHARIZARD-ex 125/197 a")).toEqual([
			"pokemon",
			"charizard",
			"ex",
			"125",
			"197",
		]);
		expect(searchTerms("%_'\"")).toEqual([]);
		expect(
			searchTerms(
				"a b c d e f g h i j k l"
					.split(" ")
					.map((w) => w + w)
					.join(" "),
			),
		).toHaveLength(8);
	});
});

const item = (over: Partial<TextExportItem>): TextExportItem => ({
	title: "Blue-Eyes White Dragon",
	priceCents: 4000,
	quantity: 1,
	condition: "LP",
	state: "available",
	...over,
});

describe("copy as text", () => {
	it("[DISC-copy-text] numbers the items with price, condition and quantity, and ends with the link", () => {
		const text = saleAsText(
			{
				title: "Weekend YGO",
				url: "https://claimsale.net/s/weekend-ygo",
				when: "Goes live Fri, Nov 20, 8:00 PM",
			},
			[
				item({}),
				item({ title: "Pulled card", state: "withdrawn" }),
				item({ title: "Booster box", condition: null, priceCents: 12_000, quantity: 3 }),
				item({ title: "Dark Magician", state: "sold_out", priceCents: 1250 }),
			],
		);
		expect(text).toBe(
			[
				"Weekend YGO",
				"Goes live Fri, Nov 20, 8:00 PM",
				"",
				"1. Blue-Eyes White Dragon · LP · $40.00",
				"2. Booster box · $120.00 (3 available)",
				"3. Dark Magician · LP · $12.50 SOLD",
				"",
				"Claim here: https://claimsale.net/s/weekend-ygo",
			].join("\n"),
		);
	});

	it("[DISC-copy-text] says so when there are no items, and skips a missing time", () => {
		expect(saleAsText({ title: "Empty", url: "https://x.test/s/e", when: null }, [])).toBe(
			"Empty\n\nNo items yet.\n\nClaim here: https://x.test/s/e",
		);
	});
});
