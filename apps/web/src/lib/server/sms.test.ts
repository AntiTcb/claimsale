import { createDb, type Db } from "@claimsale/db";
import { verifications } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { CAPTURE_PREFIX, CODE_TTL_MS, makePhoneVerifier } from "./sms.ts";

const PHONE = "+12025550123";
const twilio = { apiKeySid: "SKtest", apiKeySecret: "shh", verifyServiceSid: "VAtest" };
let db: Db;
let clock: number;
const logs: string[] = [];
const log = (record: Record<string, unknown>) => {
	logs.push(JSON.stringify(record));
};

beforeEach(() => {
	db = createDb(testD1());
	clock = 1_000_000;
	logs.length = 0;
});

const captureVerifier = () =>
	makePhoneVerifier({ mode: "capture", db, now: () => clock, code: () => "123456", log });

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const urlOf = (input: RequestInfo | URL): string =>
	typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const bodyOf = (init: RequestInit | undefined): string =>
	init?.body instanceof URLSearchParams ? init.body.toString() : "";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function fakeFetch(responses: Record<string, Response>) {
	return vi.fn<Fetch>(async (input) => {
		const url = urlOf(input);
		const key = Object.keys(responses).find((k) => url.includes(k));
		if (!key) throw new Error(`unexpected ${url}`);
		return responses[key]!.clone();
	});
}

const twilioVerifier = (fetch: Fetch) => makePhoneVerifier({ mode: "twilio", db, twilio, fetch, log });

const send = (status: number, code?: number) =>
	twilioVerifier(
		fakeFetch({
			"lookups.twilio.com": json(503, {}),
			"/Verifications": json(status, code === undefined ? {} : { code }),
		}),
	).start(PHONE);

const check = (response: Response) =>
	twilioVerifier(fakeFetch({ "/VerificationCheck": response })).check(PHONE, "000000");

describe("capture mode", () => {
	it("stores the code instead of texting it, and approves it once", async () => {
		const v = captureVerifier();
		expect(v).toMatchObject({ mode: "capture", available: true });
		expect(await v.start(PHONE)).toBe("sent");
		const rows = await db.select().from(verifications).all();
		expect(rows).toMatchObject([{ identifier: `${CAPTURE_PREFIX}${PHONE}`, value: "123456" }]);
		expect(await v.check(PHONE, "654321")).toBe("wrong");
		expect(await v.check(PHONE, "123456")).toBe("approved");
		expect(await v.check(PHONE, "123456")).toBe("expired");
	});

	it("expires codes after 10 minutes and replaces older codes for the number", async () => {
		const v = captureVerifier();
		await v.start(PHONE);
		await v.start(PHONE);
		expect(await db.select().from(verifications).all()).toHaveLength(1);
		clock += CODE_TTL_MS;
		expect(await v.check(PHONE, "123456")).toBe("expired");
	});

	it("logs that a code was captured, but never the number or the code", async () => {
		await captureVerifier().start(PHONE);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("sms code captured");
		expect(logs[0]).not.toContain("123456");
		expect(logs[0]).not.toContain("2025550123");
	});

	it("redacts the number in the default log line", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		await makePhoneVerifier({ mode: "capture", db, code: () => "111222" }).start(PHONE);
		const line = String(spy.mock.calls[0]?.[0]);
		spy.mockRestore();
		expect(line).toContain("sms code captured");
		expect(line).not.toContain("2025550123");
		expect(line).not.toContain("111222");
	});
});

describe("twilio mode", () => {
	it("fails closed to twilio for unknown modes, and is unavailable without credentials", async () => {
		const v = makePhoneVerifier({ mode: "captur", db });
		expect(v).toMatchObject({ mode: "twilio", available: false });
		expect(await v.start(PHONE)).toBe("unavailable");
		expect(await v.check(PHONE, "123456")).toBe("unavailable");
	});

	it("looks the number up, sends through Verify with an API key, and checks the code", async () => {
		const fetch = fakeFetch({
			"lookups.twilio.com": json(200, { valid: true, line_type_intelligence: { type: "mobile" } }),
			"/Verifications": json(201, { status: "pending" }),
			"/VerificationCheck": json(200, { status: "approved" }),
		});
		const v = twilioVerifier(fetch);
		expect(v).toMatchObject({ mode: "twilio", available: true });
		expect(await v.start(PHONE)).toBe("sent");
		expect(await v.check(PHONE, "123456")).toBe("approved");

		const [lookupUrl, lookupInit] = fetch.mock.calls[0]!;
		expect(urlOf(lookupUrl)).toBe(
			"https://lookups.twilio.com/v2/PhoneNumbers/%2B12025550123?Fields=line_type_intelligence",
		);
		expect(new Headers(lookupInit?.headers).get("authorization")).toBe(`Basic ${btoa("SKtest:shh")}`);
		const [sendUrl, sendInit] = fetch.mock.calls[1]!;
		expect(urlOf(sendUrl)).toBe("https://verify.twilio.com/v2/Services/VAtest/Verifications");
		expect(bodyOf(sendInit)).toBe("To=%2B12025550123&Channel=sms");
		expect(bodyOf(fetch.mock.calls[2]?.[1])).toBe("To=%2B12025550123&Code=123456");
	});

	it("refuses VoIP and invalid numbers before sending (TECH_STACK S10)", async () => {
		const voip = fakeFetch({
			"lookups.twilio.com": json(200, { valid: true, line_type_intelligence: { type: "nonFixedVoip" } }),
		});
		expect(await twilioVerifier(voip).start(PHONE)).toBe("line_type");
		expect(voip).toHaveBeenCalledTimes(1);
		expect(logs.join()).toContain("nonFixedVoip");
		expect(logs.join()).not.toContain("2025550123");

		const invalid = fakeFetch({ "lookups.twilio.com": json(200, { valid: false }) });
		expect(await twilioVerifier(invalid).start(PHONE)).toBe("invalid_number");
	});

	it("still sends when Lookup itself fails, and maps Verify's errors", async () => {
		expect(await send(201)).toBe("sent");
		expect(await send(429)).toBe("too_many");
		expect(await send(400, 60203)).toBe("too_many");
		expect(await send(400, 60200)).toBe("invalid_number");
		expect(await send(500)).toBe("unavailable");
	});

	it("maps check results: pending is wrong, 404 is expired, 60202 is too many", async () => {
		expect(await check(json(200, { status: "pending" }))).toBe("wrong");
		expect(await check(json(404, { code: 20404 }))).toBe("expired");
		expect(await check(json(429, { code: 60202 }))).toBe("too_many");
		expect(await check(json(500, {}))).toBe("unavailable");
	});

	it("reports network failures as unavailable, without the number in the log", async () => {
		const v = twilioVerifier(
			vi.fn<Fetch>(async () => {
				throw new Error(`connect failed for ${PHONE}`);
			}),
		);
		expect(await v.start(PHONE)).toBe("unavailable");
		expect(await v.check(PHONE, "123456")).toBe("unavailable");
		expect(logs).toHaveLength(2);
		expect(logs.join()).toContain("connect failed");
		expect(logs.join()).not.toContain("2025550123");
	});
});
