// Go-live claim rush (TESTING §1 "Load", STATE_MACHINES §9): 200 claims a second on one
// sale, p95 under 300 ms, through the real path web → engine RPC → SaleEngine → D1.
//
// Run against staging or a PR's isolated Worker pair, on demand (never in CI, never production):
//
//   k6 run load/claim-rush.js \
//     -e BASE_URL=https://staging.claimsale.net \
//     -e SALE_ID=<a live staging sale> -e ITEM_IDS=<id1,id2,...> \
//     -e SESSIONS=./load/sessions.json -e WARM_PATH=/s/<the sale's slug> \
//     -e CF_ACCESS_CLIENT_ID=... -e CF_ACCESS_CLIENT_SECRET=...
//
// Setup, by hand on staging:
// - a live sale whose items have quantity 1 (or more) and offers on;
// - SESSIONS: a JSON array of `Cookie` header values, one signed-in buyer each, e.g.
//   ["__Secure-better-auth.session_token=…", …]. Claims are rate-limited per buyer
//   (20 per 10 s, SM-9-entry-rate-limit), so at 200 claims a second use at least 150
//   buyers. The file holds live sessions: keep it out of git and delete it afterwards;
// - a Cloudflare Access service token for staging (Access guards it).
//
// Before the rush, setup() opens a page as each buyer, as browsers would have (so their session
// cache cookie is set); keep DURATION under that cookie's 60 s.
//
// Every buyer claims each item at most once; repeats answer 409 `already_entered`,
// which still runs the whole engine path (lock, D1 read, transition) and counts.

import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
const SALE_ID = __ENV.SALE_ID;
const ITEM_IDS = (__ENV.ITEM_IDS || "").split(",").filter(Boolean);
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "30s";
const SESSIONS = JSON.parse(open(__ENV.SESSIONS || "./sessions.json"));

if (!BASE_URL || !SALE_ID || ITEM_IDS.length === 0 || SESSIONS.length === 0) {
	throw new Error("Set BASE_URL, SALE_ID, ITEM_IDS and SESSIONS (see the header of this file)");
}
// A guard against pointing it at production by mistake.
if (
	!/^https?:\/\/(?:[^/]*staging[^/]*|claimsale-web-pr-\d+\.[^/]+|localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(
		BASE_URL,
	)
) {
	throw new Error("This load test only runs against staging, a PR's Worker pair or a local stack");
}

const rateLimited = new Counter("claims_rate_limited");
const handled = new Rate("claims_handled");

export const options = {
	scenarios: {
		go_live_rush: {
			executor: "constant-arrival-rate",
			rate: RATE,
			timeUnit: "1s",
			duration: DURATION,
			preAllocatedVUs: Math.max(50, Math.ceil(RATE * 1.5)),
			maxVUs: RATE * 4,
		},
	},
	thresholds: {
		// STATE_MACHINES §9: p95 < 300 ms at 200 claims/s on one sale.
		"http_req_duration{scenario:go_live_rush}": ["p(95)<300"],
		// Every claim gets a decision: won / backup (201) or a rule's "no" (409); never a 5xx.
		claims_handled: ["rate>0.99"],
	},
	summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const headers = (cookie) => ({
	"content-type": "application/json",
	cookie,
	...(__ENV.CF_ACCESS_CLIENT_ID
		? {
				"cf-access-client-id": __ENV.CF_ACCESS_CLIENT_ID,
				"cf-access-client-secret": __ENV.CF_ACCESS_CLIENT_SECRET,
			}
		: {}),
});

/** `name=value` of every cookie a response sets. */
const setCookies = (response) =>
	Object.values(response.cookies).flatMap((list) => list.map((c) => `${c.name}=${c.value}`));

/**
 * Each buyer opens the sale page before go-live, as a real buyer would: that request reads
 * their session from D1 once and sets the session cache cookie (AUTH-session-cookie-cache,
 * 60 s), which their claims then carry. Returns each buyer's full Cookie header.
 */
export function setup() {
	const buyers = [];
	for (let i = 0; i < SESSIONS.length; i += 50) {
		const chunk = SESSIONS.slice(i, i + 50);
		const responses = http.batch(
			chunk.map((cookie) => [
				"GET",
				// The sale page, as buyers open it before go-live (Better Auth's own endpoints are
				// limited to 100 requests a minute per address, so they can't warm 200 buyers).
				`${BASE_URL}${__ENV.WARM_PATH || "/"}`,
				null,
				{ headers: headers(cookie), jar: new http.CookieJar(), tags: { name: "warm_up" } },
			]),
		);
		responses.forEach((response, j) => buyers.push([chunk[j], ...setCookies(response)].join("; ")));
	}
	return buyers;
}

export default function claimRush(buyers) {
	// Spread buyers and items so most requests are first claims, like a real go-live.
	const n = __VU * 7919 + __ITER;
	const cookie = buyers[n % buyers.length];
	const itemId = ITEM_IDS[Math.floor(n / buyers.length) % ITEM_IDS.length];
	const response = http.post(
		`${BASE_URL}/api/sales/${SALE_ID}/entries`,
		JSON.stringify({ itemId, kind: "claim" }),
		// Its own empty jar: VUs take turns with buyers, so a shared jar would mix their cookies.
		{ headers: headers(cookie), jar: new http.CookieJar(), tags: { name: "claim" } },
	);
	if (response.status === 429) rateLimited.add(1);
	handled.add(response.status === 201 || response.status === 409);
	check(response, {
		"claim decided (201 or 409)": (r) => r.status === 201 || r.status === 409,
		"no server error": (r) => r.status < 500,
	});
}
