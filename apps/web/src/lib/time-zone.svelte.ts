import { getContext, setContext } from "svelte";
import {
	browserTimeZone,
	type DateStyle,
	FALLBACK_TIME_ZONE,
	formatDate,
	TIME_ZONE_COOKIE,
} from "./dates.ts";

const KEY = Symbol("time-zone");

interface TimeZoneState {
	readonly current: string;
}

/**
 * The root layout's time zone: the cookie's (read by the server) until the browser has
 * mounted, then the browser's own. Pages re-render when it changes.
 */
export function provideTimeZone(fromServer: () => string | null): {
	readonly current: string;
	mounted(): void;
} {
	let browser = $state<string | null>(null);
	const state = {
		get current() {
			return browser ?? fromServer() ?? FALLBACK_TIME_ZONE;
		},
		mounted() {
			browser = browserTimeZone();
			if (browser !== fromServer()) {
				// A year; the server reads it on the next request, so pages render in this zone.
				document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(browser)}; path=/; max-age=31536000; samesite=lax`;
			}
		},
	};
	setContext<TimeZoneState>(KEY, state);
	return state;
}

/** For tests and previews: a context map that pins the time zone. */
export const timeZoneContext = (timeZone: string): Map<symbol, TimeZoneState> =>
	new Map([[KEY, { current: timeZone }]]);

/**
 * A date formatter for components. Call it during component setup; the formatter
 * reads the zone when called, so the template updates once the browser's zone is known.
 * Outside the root layout (component tests) it uses the runtime's own zone.
 */
export function useDates(): (ms: number, style?: DateStyle) => string {
	const zone = getContext<TimeZoneState | undefined>(KEY);
	return (ms, style = "dateTime") => formatDate(ms, style, zone?.current ?? browserTimeZone());
}
