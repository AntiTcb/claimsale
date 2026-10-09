/**
 * Money is always integer cents (PLAN §6). These helpers never use floating-point
 * cents, so results are exact.
 */

export type Cents = number;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCents(cents: Cents): string {
	if (!Number.isSafeInteger(cents)) {
		throw new RangeError(`cents must be a safe integer, got ${cents}`);
	}
	return usd.format(cents / 100);
}

/** Percentages offered as quick buttons under the price input (D64). */
export const MARKET_PERCENT_PRESETS = [70, 75, 80, 85, 90, 100] as const;

/** Smallest price a % of market button will produce. */
export const MIN_SUGGESTED_PRICE: Cents = 5;

/**
 * Price for a "% of market" button (D64).
 *
 * @spec TCG-market-pct
 *
 * The raw value is rounded down to a $0.05 step below $5 and to a $0.25 step from
 * $5 up, and never goes below {@link MIN_SUGGESTED_PRICE}.
 */
export function priceFromMarketPercent(marketCents: Cents, percent: number): Cents {
	if (!Number.isSafeInteger(marketCents) || marketCents <= 0) {
		throw new RangeError(`marketCents must be a positive integer, got ${marketCents}`);
	}
	if (!Number.isInteger(percent) || percent <= 0 || percent > 100) {
		throw new RangeError(`percent must be an integer in 1..100, got ${percent}`);
	}
	const raw = Math.floor((marketCents * percent) / 100);
	const step = raw < 500 ? 5 : 25;
	return Math.max(MIN_SUGGESTED_PRICE, raw - (raw % step));
}
