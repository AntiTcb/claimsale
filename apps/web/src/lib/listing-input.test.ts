import { describe, expect, it } from "vitest";
import {
	DEFAULT_TERMS,
	describeItem,
	gameName,
	GAMES,
	parseLocalDateTime,
	parsePrice,
	parseQuantity,
	priceInputValue,
	readTerms,
	validateAttributes,
	validateItem,
	validateSaleDetails,
	validateTerms,
} from "./listing-input.ts";

describe("listing input", () => {
	it("describes an item in one line, skipping a missing condition", () => {
		expect(describeItem("yugioh", "single", "LP")).toBe("Yu-Gi-Oh! · Single · Lightly Played");
		expect(describeItem("pokemon", "sealed", null)).toBe("Pokémon · Sealed");
		expect(describeItem("chess", "box", "MINT")).toBe("chess · box · MINT");
	});

	it("parses prices into integer cents without float cents", () => {
		expect(parsePrice("12")).toEqual({ ok: true, value: 1200 });
		expect(parsePrice(" $12.5 ")).toEqual({ ok: true, value: 1250 });
		expect(parsePrice("1,200.99")).toEqual({ ok: true, value: 120099 });
		expect(parsePrice("0.29")).toEqual({ ok: true, value: 29 });
		expect(parsePrice("0")).toMatchObject({ ok: false });
		expect(parsePrice("12.345")).toMatchObject({ ok: false });
		expect(parsePrice("-5")).toMatchObject({ ok: false });
		expect(parsePrice("100000.01")).toMatchObject({ ok: false });
		expect(priceInputValue(1205)).toBe("12.05");
		expect(priceInputValue(7)).toBe("0.07");
	});

	it("parses quantities 1–999, defaulting to 1", () => {
		expect(parseQuantity("")).toEqual({ ok: true, value: 1 });
		expect(parseQuantity("3")).toEqual({ ok: true, value: 3 });
		expect(parseQuantity("0").ok).toBe(false);
		expect(parseQuantity("1.5").ok).toBe(false);
		expect(parseQuantity("1000").ok).toBe(false);
	});

	it("validates sale details", () => {
		expect(
			validateSaleDetails({ title: "  Big   sale ", description: " hi ", visibility: "public" }),
		).toEqual({
			ok: true,
			value: { title: "Big sale", descriptionMd: "hi", visibility: "public" },
		});
		const bad = validateSaleDetails({ title: "", description: "x".repeat(5001), visibility: "secret" });
		expect(bad).toMatchObject({
			ok: false,
			errors: { title: expect.any(String), description: expect.any(String), visibility: expect.any(String) },
		});
	});

	it("validates terms; 24h payment deadlines are Pro only", () => {
		const input = {
			paymentMethods: ["venmo", "venmo", "bogus"],
			paymentDeadlineHours: "48",
			shipsTo: " US ",
			rulesMd: "",
			offerVisibility: "visible",
			reviewEveryClaim: true,
			allowBackupOffers: false,
			confirmClaims: true,
		};
		expect(validateTerms(input, false)).toEqual({
			ok: true,
			value: {
				...DEFAULT_TERMS,
				paymentMethods: ["venmo"],
				shipsTo: "US",
				offerVisibility: "visible",
				reviewEveryClaim: true,
				allowBackupOffers: false,
			},
		});
		expect(validateTerms({ ...input, paymentDeadlineHours: "24" }, false)).toMatchObject({
			ok: false,
			errors: { paymentDeadlineHours: "A 24-hour deadline is a Pro feature" },
		});
		expect(validateTerms({ ...input, paymentDeadlineHours: "24" }, true)).toMatchObject({
			ok: true,
			value: { paymentDeadlineHours: 24 },
		});
		expect(validateTerms({ ...input, paymentMethods: [], paymentDeadlineHours: "12" }, true)).toMatchObject({
			ok: false,
			errors: { paymentMethods: expect.any(String), paymentDeadlineHours: expect.any(String) },
		});
		expect(readTerms(null)).toEqual(DEFAULT_TERMS);
		expect(
			readTerms({ paymentMethods: [1, "zelle"], paymentDeadlineHours: 24, allowBackupOffers: false }),
		).toMatchObject({
			paymentMethods: ["zelle"],
			paymentDeadlineHours: 24,
			allowBackupOffers: false,
		});
	});

	const terms = {
		paymentMethods: ["venmo"],
		paymentDeadlineHours: "48",
		shipsTo: "US",
		rulesMd: "",
		offerVisibility: "blind",
		reviewEveryClaim: false,
		allowBackupOffers: true,
		confirmClaims: true,
	};

	it("[SM-4.2-window-length] only Pro sellers set the decision window, in whole hours", () => {
		expect(validateTerms({ ...terms, decisionWindowHours: " 6 " }, true)).toMatchObject({
			ok: true,
			value: { decisionWindowHours: 6 },
		});
		expect(validateTerms({ ...terms, decisionWindowHours: "" }, false)).toMatchObject({
			ok: true,
			value: { decisionWindowHours: null },
		});
		expect(validateTerms({ ...terms, decisionWindowHours: "6" }, false)).toMatchObject({
			ok: false,
			errors: { decisionWindowHours: "Setting the decision window is a Pro feature" },
		});
		for (const bad of ["0", "1.5", "169", "-2", "abc"]) {
			expect(validateTerms({ ...terms, decisionWindowHours: bad }, true)).toMatchObject({
				ok: false,
				errors: { decisionWindowHours: expect.stringContaining("whole hours") },
			});
		}
		expect(readTerms({ decisionWindowHours: 12 }).decisionWindowHours).toBe(12);
	});

	it("[SM-4.2-window-length] caps the window at 7 days unless an admin approved more, never over 30", () => {
		expect(validateTerms({ ...terms, decisionWindowHours: "168" }, true)).toMatchObject({ ok: true });
		expect(validateTerms({ ...terms, decisionWindowHours: "169" }, true)).toMatchObject({
			ok: false,
			errors: { decisionWindowHours: "Enter whole hours from 1 to 168, or leave it empty" },
		});
		expect(validateTerms({ ...terms, decisionWindowHours: "336" }, true, 336)).toMatchObject({
			ok: true,
			value: { decisionWindowHours: 336 },
		});
		expect(validateTerms({ ...terms, decisionWindowHours: "721" }, true, 2000)).toMatchObject({
			ok: false,
			errors: { decisionWindowHours: expect.stringContaining("1 to 720") },
		});
		expect(readTerms({ decisionWindowHours: -1 }).decisionWindowHours).toBeNull();
	});

	it("[SM-4.1-buyer-requirements] sets the account-age requirement; the verified email isn't a setting (D68)", () => {
		const thirty = validateTerms({ ...terms, minAccountAgeDays: "30" }, false);
		expect(thirty).toMatchObject({ ok: true, value: { minAccountAgeDays: 30 } });
		expect(thirty.ok && "requireVerifiedEmail" in thirty.value).toBe(false);
		expect(validateTerms({ ...terms, minAccountAgeDays: "" }, false)).toMatchObject({
			ok: true,
			value: { minAccountAgeDays: 0 },
		});
		expect(validateTerms({ ...terms, minAccountAgeDays: "400" }, false)).toMatchObject({
			ok: false,
			errors: { minAccountAgeDays: expect.any(String) },
		});
		const stored = readTerms({ requireVerifiedEmail: false, minAccountAgeDays: 7 });
		expect(stored).toMatchObject({ minAccountAgeDays: 7 });
		expect("requireVerifiedEmail" in stored).toBe(false);
		expect(readTerms({ minAccountAgeDays: "7" })).toMatchObject({ minAccountAgeDays: 0 });
	});

	it("asks buyers to confirm claims unless the seller turned it off [LIVE-claim-confirm]", () => {
		expect(DEFAULT_TERMS.confirmClaims).toBe(true);
		expect(readTerms({}).confirmClaims).toBe(true);
		expect(readTerms({ confirmClaims: false }).confirmClaims).toBe(false);
		const input = {
			paymentMethods: ["venmo"],
			paymentDeadlineHours: "48",
			shipsTo: "",
			rulesMd: "",
			offerVisibility: "blind",
			reviewEveryClaim: false,
			allowBackupOffers: true,
			confirmClaims: false,
		};
		expect(validateTerms(input, false)).toMatchObject({ ok: true, value: { confirmClaims: false } });
	});

	it("validates items, with free-form attributes until the per-game schemas land", () => {
		const input = {
			title: "Charizard",
			price: "250",
			quantity: "",
			gameId: "pokemon",
			kind: "graded",
			condition: "",
			attributes: '{"grader":"PSA","grade":10}',
		};
		expect(validateItem(input)).toEqual({
			ok: true,
			value: {
				title: "Charizard",
				priceCents: 25000,
				quantity: 1,
				gameId: "pokemon",
				kind: "graded",
				condition: null,
				attributes: { grader: "PSA", grade: 10 },
			},
		});
		const bad = validateItem({
			title: "",
			price: "x",
			quantity: "0",
			gameId: "chess",
			kind: "box",
			condition: "MINT",
			attributes: "[]",
		});
		expect(bad.ok).toBe(false);
		expect(!bad.ok && Object.keys(bad.errors).toSorted()).toEqual([
			"condition",
			"gameId",
			"kind",
			"price",
			"quantity",
			"title",
		]);
		expect(validateAttributes("pokemon", "single", "")).toEqual({ ok: true, value: {} });
		expect(validateAttributes("pokemon", "single", "{bad")).toMatchObject({ ok: false });
		expect(validateAttributes("pokemon", "single", "[1]")).toMatchObject({ ok: false });
		expect(validateAttributes("pokemon", "single", '{"Bad Key": 1}')).toMatchObject({ ok: false });
		expect(validateAttributes("pokemon", "single", '{"nested": {"a": 1}}')).toMatchObject({ ok: false });
		expect(validateAttributes("pokemon", "single", `{"a":"${"x".repeat(4000)}"}`)).toMatchObject({
			ok: false,
		});
		expect(validateItem({ ...input, attributes: "{bad" })).toMatchObject({
			ok: false,
			errors: { attributes: expect.any(String) },
		});
	});

	it("has no 'Other TCG': only accessories may skip the game", () => {
		const input = {
			title: "Playmat",
			price: "20",
			quantity: "",
			gameId: "none",
			kind: "accessory",
			condition: "",
			attributes: "",
		};
		expect(GAMES.some((g) => g.id === "other")).toBe(false);
		expect(validateItem(input)).toMatchObject({ ok: true, value: { gameId: "none", kind: "accessory" } });
		expect(validateItem({ ...input, kind: "single" })).toMatchObject({
			ok: false,
			errors: { gameId: "Only accessories can skip the game" },
		});
		expect(validateItem({ ...input, gameId: "other" })).toMatchObject({
			ok: false,
			errors: { gameId: "Choose a game" },
		});
		// Items saved with WS-A's placeholder still read sensibly.
		expect([gameName("other"), gameName("none"), gameName("mtg")]).toEqual([
			"Other TCG",
			"Not game-specific",
			"Magic: The Gathering",
		]);
	});

	it("reads datetime-local values in the browser's time zone", () => {
		// 20:00 in New York (UTC-5 in November, getTimezoneOffset = 300) is 01:00 UTC the next day.
		expect(parseLocalDateTime("2026-11-20T20:00", 300)).toBe(Date.UTC(2026, 10, 21, 1, 0));
		expect(parseLocalDateTime("2026-11-20T20:00", 0)).toBe(Date.UTC(2026, 10, 20, 20, 0));
		expect(parseLocalDateTime("tomorrow", 0)).toBeNull();
	});
});
