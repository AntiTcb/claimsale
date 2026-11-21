/**
 * Dates on pages, in the viewer's time zone.
 *
 * Pages render on the server first, where the Worker's clock is UTC, and Svelte keeps
 * the server's text when the page hydrates. So every date is formatted with an explicit
 * time zone: the one the browser reported in the `tz` cookie, or UTC until it has.
 * The locale is fixed so the server and the browser produce the same text.
 */

export const TIME_ZONE_COOKIE = "tz";
export const FALLBACK_TIME_ZONE = "UTC";
const LOCALE = "en-US";

const STYLES = {
	/** "Nov 20, 2026, 6:09 PM" */
	dateTime: { dateStyle: "medium", timeStyle: "short" },
	/** "Friday, November 20, 2026 at 6:09 PM" */
	fullDateTime: { dateStyle: "full", timeStyle: "short" },
	/** "Nov 20, 2026" */
	date: { dateStyle: "medium" },
	/** "Nov 20, 6:09 PM" */
	short: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
	/** "November 2026" */
	monthYear: { month: "long", year: "numeric" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof STYLES;

/** Formats server milliseconds in the given IANA time zone. */
export function formatDate(ms: number, style: DateStyle, timeZone: string): string {
	// ICU versions differ on narrow and no-break spaces ("6:10\u202FPM"); plain spaces keep
	// the server's and the browser's text the same.
	return new Date(ms).toLocaleString(LOCALE, { ...STYLES[style], timeZone }).replace(/[\u202F\u00A0]/g, " ");
}

/** Whether a value (from a cookie, so untrusted) names a time zone Intl knows. */
export function isTimeZone(value: string | undefined): value is string {
	if (!value || value.length > 64) return false;
	try {
		return new Intl.DateTimeFormat(LOCALE, { timeZone: value }).resolvedOptions().timeZone !== "";
	} catch {
		return false;
	}
}

/** The browser's own time zone. */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
