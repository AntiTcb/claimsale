/**
 * A fake TCGCSV for tests: serves the recorded fixtures in test/fixtures/tcgcsv
 * (Riftbound, category 89) and never touches the network. Recorded on 2026-11-15
 * (groups and the Proving Grounds products/prices are real, trimmed; the Promo
 * group's files are synthetic and say so).
 */
import groups89 from "./fixtures/tcgcsv/groups-89.json?raw";
import lastUpdated from "./fixtures/tcgcsv/last-updated.txt?raw";
import prices24343 from "./fixtures/tcgcsv/prices-89-24343.json?raw";
import prices24439 from "./fixtures/tcgcsv/prices-89-24439.json?raw";
import products24343 from "./fixtures/tcgcsv/products-89-24343.json?raw";
import products24439 from "./fixtures/tcgcsv/products-89-24439.json?raw";

export const FIXTURE_BASE = "https://tcgcsv.test";
export const FIXTURE_BUILD = lastUpdated.trim();

export const fixtureFiles: Readonly<Record<string, string>> = {
	"/last-updated.txt": lastUpdated,
	"/tcgplayer/89/groups": groups89,
	"/tcgplayer/89/24439/products": products24439,
	"/tcgplayer/89/24439/prices": prices24439,
	"/tcgplayer/89/24343/products": products24343,
	"/tcgplayer/89/24343/prices": prices24343,
};

export interface FakeTcgCsv {
	readonly fetch: typeof fetch;
	/** Paths requested, in order. */
	readonly requests: string[];
	readonly userAgents: (string | null)[];
	/** Replace a path's body, or its whole response. */
	readonly files: Record<string, string | (() => Response)>;
}

/** Answers like TCGCSV at `base`; anything else fails the test (no real network). */
export function fakeTcgCsv(base = FIXTURE_BASE): FakeTcgCsv {
	const files: Record<string, string | (() => Response)> = { ...fixtureFiles };
	const requests: string[] = [];
	const userAgents: (string | null)[] = [];
	const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== new URL(base).origin) throw new Error(`unexpected network request to ${url.href}`);
		requests.push(url.pathname);
		userAgents.push(new Headers(init?.headers).get("user-agent"));
		const file = files[url.pathname];
		if (file === undefined) return new Response('{"success":false}', { status: 404 });
		return typeof file === "string" ? new Response(file, { status: 200 }) : file();
	};
	return { fetch: fake, requests, userAgents, files };
}

/** The same build stamp, a day later. */
export const NEXT_BUILD = "2026-11-16T20:05:00+0000";
