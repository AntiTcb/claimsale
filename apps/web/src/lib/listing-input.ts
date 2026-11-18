import { enabledGames, NO_GAME_ID, type Cents, type SaleVisibility, type Validated } from "@claimsale/core";

/**
 * Form input for sales and items, shared by the pages (client) and the form
 * actions (server, which always re-validates).
 *
 * `GAMES` comes from the core games registry. Item imports validate with core's
 * per-game schemas (`TCG-attribute-schema`, `validateImportRow`); the hand-entry form
 * here still takes free-form attributes, which catalog autofill fills in (WS-G).
 * Moving the form onto the per-game field lists is open, and callers keep the same
 * signatures when it happens.
 */

const valid = <T>(value: T): Validated<T> => ({ ok: true, value });
const invalid = (message: string): Validated<never> => ({ ok: false, message });

/**
 * The games a seller can pick: the core registry's enabled games (D61), whose slugs
 * are the `games` table's ids. There is no "Other TCG": every kind but accessories
 * needs a registry game (core's attribute schemas, catalog autofill and the market
 * price aid are all per game), and a game outside the registry is added there first.
 */
export const GAMES: readonly { readonly id: string; readonly name: string }[] = enabledGames().map(
	(game) => ({ id: game.slug, name: game.name }),
);

/**
 * Accessories may skip the game (PLAN §3 item kinds: "optional game"). `items.game_id`
 * is NOT NULL, so they store this id; it matches no game, so browse by game skips them.
 */
export const NO_GAME = { id: NO_GAME_ID, name: "Not game-specific" } as const;

/** Names for ids that aren't games: NO_GAME, and WS-A's "Other TCG" placeholder on older items. */
const OTHER_GAME_NAMES: Readonly<Record<string, string>> = { [NO_GAME.id]: NO_GAME.name, other: "Other TCG" };

export type GameId = string;

export const ITEM_KINDS = [
	{ id: "single", name: "Single" },
	{ id: "graded", name: "Graded single" },
	{ id: "sealed", name: "Sealed" },
	{ id: "accessory", name: "Accessory" },
	{ id: "lot", name: "Lot / bulk" },
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number]["id"];

/** The TCGplayer-style scale every game uses (PLAN §3). */
export const CONDITIONS = [
	{ id: "NM", name: "Near Mint" },
	{ id: "LP", name: "Lightly Played" },
	{ id: "MP", name: "Moderately Played" },
	{ id: "HP", name: "Heavily Played" },
	{ id: "DMG", name: "Damaged" },
] as const;

export type Condition = (typeof CONDITIONS)[number]["id"];

export const gameName = (id: string): string =>
	GAMES.find((g) => g.id === id)?.name ?? OTHER_GAME_NAMES[id] ?? id;
export const kindName = (id: string): string => ITEM_KINDS.find((k) => k.id === id)?.name ?? id;
/** "Yu-Gi-Oh! · Single · Lightly Played": the one-line summary under an item's title. */
export const describeItem = (gameId: string, kind: string, condition: string | null): string =>
	[gameName(gameId), kindName(kind), condition ? conditionName(condition) : ""].filter(Boolean).join(" · ");
export const conditionName = (id: string | null): string =>
	CONDITIONS.find((c) => c.id === id)?.name ?? id ?? "";

// ---------------------------------------------------------------------------
// Money

export const MAX_PRICE_CENTS = 10_000_000; // $100,000

/** Parses "12", "12.5", "$12.50" or "1,200.00" into integer cents. Never uses float cents. */
export function parsePrice(input: string): Validated<Cents> {
	const text = input.trim().replace(/^\$/, "").replaceAll(",", "");
	const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
	if (!match) return invalid("Enter a price like 12.50");
	const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
	if (cents <= 0) return invalid("The price must be more than $0");
	if (cents > MAX_PRICE_CENTS) return invalid("The price must be at most $100,000");
	return valid(cents);
}

/** Cents back to the input's own format, e.g. 1250 → "12.50". */
export function priceInputValue(cents: Cents): string {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Sales

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 5000;

export interface SaleDetailsInput {
	readonly title: string;
	readonly description: string;
	readonly visibility: string;
}

export interface SaleDetails {
	readonly title: string;
	readonly descriptionMd: string;
	readonly visibility: SaleVisibility;
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export function validateTitle(input: string): Validated<string> {
	const title = input.trim().replace(/\s+/g, " ");
	if (title.length === 0) return invalid("Enter a title");
	if (title.length > TITLE_MAX) return invalid(`Use at most ${TITLE_MAX} characters`);
	return valid(title);
}

export function validateSaleDetails(
	input: SaleDetailsInput,
): Validated<SaleDetails> | { ok: false; errors: FieldErrors<"title" | "description" | "visibility"> } {
	const errors: FieldErrors<"title" | "description" | "visibility"> = {};
	const title = validateTitle(input.title);
	if (!title.ok) errors.title = title.message;
	const description = input.description.trim();
	if (description.length > DESCRIPTION_MAX) errors.description = `Use at most ${DESCRIPTION_MAX} characters`;
	const visibility = isVisibility(input.visibility) ? input.visibility : null;
	if (visibility === null) errors.visibility = "Choose who can see the sale";
	if (!title.ok || visibility === null || Object.keys(errors).length > 0) return { ok: false, errors };
	return valid({ title: title.value, descriptionMd: description, visibility });
}

export const isVisibility = (value: string): value is SaleVisibility =>
	value === "public" || value === "unlisted" || value === "private";

export const PAYMENT_METHODS = [
	{ id: "paypal_gs", name: "PayPal Goods & Services" },
	{ id: "paypal_ff", name: "PayPal Friends & Family" },
	{ id: "venmo", name: "Venmo" },
	{ id: "zelle", name: "Zelle" },
	{ id: "cashapp", name: "Cash App" },
] as const;

/** D39: methods without buyer protection get a warning, never a block. */
export const UNPROTECTED_METHODS: ReadonlySet<string> = new Set(["paypal_ff", "zelle", "cashapp"]);

export interface SaleTerms {
	readonly paymentMethods: readonly string[];
	/** D13: 48h by default; Pro sellers may choose 24h. */
	readonly paymentDeadlineHours: 24 | 48;
	readonly shipsTo: string;
	readonly rulesMd: string;
	/** D26. */
	readonly offerVisibility: "blind" | "visible";
	/** D34. */
	readonly reviewEveryClaim: boolean;
	/** D43, on by default. */
	readonly allowBackupOffers: boolean;
	/** D25: Pro sellers only; null is the default 24h window. */
	readonly decisionWindowHours: number | null;
	/** D20: claims need a verified email; on by default (Pro buyers bypass it, D29). */
	readonly requireVerifiedEmail: boolean;
	/** D29: the youngest account that may claim, in days; 0 allows any (Pro buyers bypass it). */
	readonly minAccountAgeDays: number;
	/** PLAN 3 (Claim): "Claims are binding. Claim for $40?" On by default; off for sales where speed matters. */
	readonly confirmClaims: boolean;
}

export const DEFAULT_TERMS: SaleTerms = {
	paymentMethods: ["paypal_gs"],
	paymentDeadlineHours: 48,
	shipsTo: "US only",
	rulesMd: "",
	offerVisibility: "blind",
	reviewEveryClaim: false,
	allowBackupOffers: true,
	decisionWindowHours: null,
	requireVerifiedEmail: true,
	minAccountAgeDays: 0,
	confirmClaims: true,
};

/** The longest decision window a Pro seller can set: the longest a sale can run (D42). */
export const DECISION_WINDOW_MAX_HOURS = 14 * 24;
export const MIN_ACCOUNT_AGE_MAX_DAYS = 365;

export interface TermsInput {
	readonly paymentMethods: readonly string[];
	readonly paymentDeadlineHours: string;
	readonly shipsTo: string;
	readonly rulesMd: string;
	readonly offerVisibility: string;
	readonly reviewEveryClaim: boolean;
	readonly allowBackupOffers: boolean;
	/** Empty for the default 24h. */
	readonly decisionWindowHours?: string;
	readonly requireVerifiedEmail?: boolean;
	/** Empty for no minimum. */
	readonly minAccountAgeDays?: string;
	readonly confirmClaims: boolean;
}

type TermsField =
	| "paymentMethods"
	| "paymentDeadlineHours"
	| "shipsTo"
	| "rulesMd"
	| "decisionWindowHours"
	| "minAccountAgeDays";

/** A whole number from `min` to `max`; empty is null. */
function wholeNumber(text: string | undefined, min: number, max: number): number | null | "invalid" {
	const trimmed = (text ?? "").trim();
	if (trimmed === "") return null;
	if (!/^\d{1,4}$/.test(trimmed)) return "invalid";
	const n = Number(trimmed);
	return n >= min && n <= max ? n : "invalid";
}

/**
 * The sale's terms form.
 *
 * @spec SM-4.2-window-length — only Pro sellers set the decision window.
 * @spec SM-4.1-buyer-requirements — the verified-email and account-age requirements.
 */
export function validateTerms(
	input: TermsInput,
	sellerIsPro: boolean,
): Validated<SaleTerms> | { ok: false; errors: FieldErrors<TermsField> } {
	const errors: FieldErrors<TermsField> = {};
	const known = new Set<string>(PAYMENT_METHODS.map((m) => m.id));
	const methods = [...new Set(input.paymentMethods)].filter((m) => known.has(m));
	if (methods.length === 0) errors.paymentMethods = "Choose at least one payment method";
	const hours = input.paymentDeadlineHours === "24" ? 24 : input.paymentDeadlineHours === "48" ? 48 : null;
	if (hours === null) errors.paymentDeadlineHours = "Choose a payment deadline";
	else if (hours === 24 && !sellerIsPro) errors.paymentDeadlineHours = "A 24-hour deadline is a Pro feature";
	const shipsTo = input.shipsTo.trim();
	if (shipsTo.length > 200) errors.shipsTo = "Use at most 200 characters";
	const rulesMd = input.rulesMd.trim();
	if (rulesMd.length > DESCRIPTION_MAX) errors.rulesMd = `Use at most ${DESCRIPTION_MAX} characters`;
	const window = wholeNumber(input.decisionWindowHours, 1, DECISION_WINDOW_MAX_HOURS);
	if (window === "invalid")
		errors.decisionWindowHours = `Enter whole hours from 1 to ${DECISION_WINDOW_MAX_HOURS}, or leave it empty`;
	else if (window !== null && !sellerIsPro)
		errors.decisionWindowHours = "Setting the decision window is a Pro feature";
	const minAge = wholeNumber(input.minAccountAgeDays, 0, MIN_ACCOUNT_AGE_MAX_DAYS);
	if (minAge === "invalid")
		errors.minAccountAgeDays = `Enter whole days from 0 to ${MIN_ACCOUNT_AGE_MAX_DAYS}, or leave it empty`;
	if (Object.keys(errors).length > 0 || hours === null || window === "invalid" || minAge === "invalid") {
		return { ok: false, errors };
	}
	return valid({
		paymentMethods: methods,
		paymentDeadlineHours: hours,
		shipsTo,
		rulesMd,
		offerVisibility: input.offerVisibility === "visible" ? "visible" : "blind",
		reviewEveryClaim: input.reviewEveryClaim,
		allowBackupOffers: input.allowBackupOffers,
		decisionWindowHours: window,
		requireVerifiedEmail: input.requireVerifiedEmail ?? true,
		minAccountAgeDays: minAge ?? 0,
		confirmClaims: input.confirmClaims,
	});
}

/** Reads stored terms JSON back, falling back to the defaults field by field. */
export function readTerms(stored: Record<string, unknown> | null | undefined): SaleTerms {
	const t = stored ?? {};
	const methods = Array.isArray(t["paymentMethods"])
		? t["paymentMethods"].filter((m): m is string => typeof m === "string")
		: DEFAULT_TERMS.paymentMethods;
	return {
		paymentMethods: methods,
		paymentDeadlineHours: t["paymentDeadlineHours"] === 24 ? 24 : 48,
		shipsTo: typeof t["shipsTo"] === "string" ? t["shipsTo"] : DEFAULT_TERMS.shipsTo,
		rulesMd: typeof t["rulesMd"] === "string" ? t["rulesMd"] : "",
		offerVisibility: t["offerVisibility"] === "visible" ? "visible" : "blind",
		reviewEveryClaim: t["reviewEveryClaim"] === true,
		allowBackupOffers: t["allowBackupOffers"] !== false,
		decisionWindowHours: positiveInt(t["decisionWindowHours"]),
		requireVerifiedEmail: t["requireVerifiedEmail"] !== false,
		minAccountAgeDays: positiveInt(t["minAccountAgeDays"]) ?? 0,
		confirmClaims: t["confirmClaims"] !== false,
	};
}

const positiveInt = (value: unknown): number | null =>
	typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

// ---------------------------------------------------------------------------
// Items

export const QUANTITY_MAX = 999;
export const ATTRIBUTES_MAX_BYTES = 4000;

export interface ItemInput {
	readonly title: string;
	readonly price: string;
	readonly quantity: string;
	readonly gameId: string;
	readonly kind: string;
	readonly condition: string;
	/** Free-form JSON object until the per-game schemas land (WS-B). */
	readonly attributes: string;
}

export interface ItemFields {
	readonly title: string;
	readonly priceCents: Cents;
	readonly quantity: number;
	readonly gameId: GameId;
	readonly kind: ItemKind;
	readonly condition: Condition | null;
	readonly attributes: Record<string, string | number | boolean>;
	/**
	 * The linked catalog product (`catalog_products.id`), resolved on the server from the
	 * `tcgplayer_product_id` attribute. Undefined leaves the stored link as it is.
	 */
	readonly catalogProductId?: string | null;
}

export type ItemErrors = FieldErrors<keyof ItemInput>;

export function parseQuantity(input: string): Validated<number> {
	const text = input.trim() === "" ? "1" : input.trim();
	if (!/^\d{1,3}$/.test(text)) return invalid(`Enter a whole number from 1 to ${QUANTITY_MAX}`);
	const n = Number(text);
	return n >= 1 && n <= QUANTITY_MAX ? valid(n) : invalid(`Enter a whole number from 1 to ${QUANTITY_MAX}`);
}

/**
 * Item attributes. Today: a flat JSON object of strings, numbers and booleans.
 * WS-B replaces the body with the game × kind Effect Schema (`TCG-attribute-schema`).
 */
export function validateAttributes(
	_gameId: GameId,
	_kind: ItemKind,
	input: string,
): Validated<Record<string, string | number | boolean>> {
	const text = input.trim();
	if (text === "") return valid({});
	if (text.length > ATTRIBUTES_MAX_BYTES) return invalid("Attributes are too long");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return invalid('Use JSON, e.g. {"set": "LOB", "edition": "1st"}');
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return invalid('Use a JSON object, e.g. {"set": "LOB"}');
	}
	const out: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(key))
			return invalid(`"${key.slice(0, 40)}" isn't a valid attribute name`);
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
			return invalid(`"${key}" must be text, a number or true/false`);
		}
		out[key] = value;
	}
	return valid(out);
}

export function validateItem(
	input: ItemInput,
): { ok: true; value: ItemFields } | { ok: false; errors: ItemErrors } {
	const errors: ItemErrors = {};
	const title = validateTitle(input.title);
	if (!title.ok) errors.title = title.message;
	const price = parsePrice(input.price);
	if (!price.ok) errors.price = price.message;
	const quantity = parseQuantity(input.quantity);
	if (!quantity.ok) errors.quantity = quantity.message;
	const kind = ITEM_KINDS.find((k) => k.id === input.kind);
	if (!kind) errors.kind = "Choose a kind";
	const game =
		GAMES.find((g) => g.id === input.gameId) ??
		(input.gameId === NO_GAME.id && kind?.id === "accessory" ? NO_GAME : undefined);
	if (!game)
		errors.gameId = input.gameId === NO_GAME.id ? "Only accessories can skip the game" : "Choose a game";
	const condition =
		input.condition === "" ? null : (CONDITIONS.find((c) => c.id === input.condition) ?? undefined);
	if (condition === undefined) errors.condition = "Choose a condition";
	const attributes = game && kind ? validateAttributes(game.id, kind.id, input.attributes) : valid({});
	if (!attributes.ok) errors.attributes = attributes.message;
	if (!title.ok || !price.ok || !quantity.ok || !game || !kind || condition === undefined || !attributes.ok) {
		return { ok: false, errors };
	}
	return {
		ok: true,
		value: {
			title: title.value,
			priceCents: price.value,
			quantity: quantity.value,
			gameId: game.id,
			kind: kind.id,
			condition: condition?.id ?? null,
			attributes: attributes.value,
		},
	};
}

// ---------------------------------------------------------------------------
// Scheduling

/**
 * Reads a `datetime-local` value ("2026-11-20T20:00") typed in the seller's time
 * zone. The page sends the browser's offset with the form (`tzOffset`, in minutes
 * as `Date#getTimezoneOffset` returns it: UTC minus local time).
 */
export function parseLocalDateTime(value: string, tzOffsetMinutes: number): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const [y = 0, mo = 0, d = 0, h = 0, mi = 0] = match.slice(1).map(Number);
	const utc = Date.UTC(y, mo - 1, d, h, mi);
	return Number.isFinite(utc) ? utc + tzOffsetMinutes * 60_000 : null;
}
