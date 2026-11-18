import { LIVE_VIEWER_HEADER } from "@claimsale/core";
import { createDb, eq, type Db } from "@claimsale/db";
import { sales } from "@claimsale/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { liveSnapshotFor, liveUpgrade, type LiveBinding } from "./live.ts";
import { unlockToken } from "./sale-access.ts";
import { createDraft, setPrivateAccess } from "./sales.ts";

const SECRET = "test-secret-at-least-32-characters-long";
const ORIGIN = "https://claimsale.test";
const now = Date.UTC(2026, 10, 15, 12);
const buyer = { id: "buyer", email: "buyer@example.test", emailVerified: true };
const seller = { id: "seller", email: "seller@example.test", emailVerified: true };

let db: Db;
beforeEach(async () => {
	db = createDb(testD1());
	await addUser(db, "seller");
	await addUser(db, "buyer");
});

async function sale(visibility: "unlisted" | "private" = "unlisted", status: "draft" | "live" = "live") {
	const draft = await createDraft(
		db,
		{ id: "seller", tier: "pro" },
		{ title: "Sale", descriptionMd: "", visibility },
		now,
	);
	if (!draft.ok) throw new Error("setup");
	if (status === "live")
		await db.update(sales).set({ status, liveAt: now }).where(eq(sales.id, draft.value.id));
	return draft.value.id;
}

const upgradeHeaders = (extra: Record<string, string> = {}) => ({
	headers: new Headers({ upgrade: "websocket", origin: ORIGIN, ...extra }),
});

const deps = () => ({ db, secret: SECRET });

describe("opening the live socket", () => {
	it("forwards a signed-in buyer's upgrade with the session's user, never the browser's word [LIVE-access]", async () => {
		const saleId = await sale();
		const decision = await liveUpgrade(
			deps(),
			{ user: buyer, unlockCookie: undefined },
			saleId,
			upgradeHeaders({ [LIVE_VIEWER_HEADER]: "someone-else" }),
			ORIGIN,
		);
		if (decision.kind !== "forward") throw new Error(`refused: ${decision.message}`);
		expect(new URL(decision.request.url).pathname).toBe(`/live/${saleId}`);
		expect(decision.request.headers.get("upgrade")).toBe("websocket");
		expect(decision.request.headers.get(LIVE_VIEWER_HEADER)).toBe("buyer");
	});

	it("forwards a visitor without a viewer [LIVE-access]", async () => {
		const saleId = await sale();
		const decision = await liveUpgrade(
			deps(),
			{ user: null, unlockCookie: undefined },
			saleId,
			upgradeHeaders(),
			ORIGIN,
		);
		expect(decision.kind === "forward" && decision.request.headers.has(LIVE_VIEWER_HEADER)).toBe(false);
	});

	it("refuses plain requests and other sites' pages [LIVE-access]", async () => {
		const saleId = await sale();
		const viewer = { user: buyer, unlockCookie: undefined };
		expect(await liveUpgrade(deps(), viewer, saleId, { headers: new Headers() }, ORIGIN)).toMatchObject({
			kind: "refuse",
			status: 426,
		});
		expect(
			await liveUpgrade(deps(), viewer, saleId, upgradeHeaders({ origin: "https://evil.test" }), ORIGIN),
		).toMatchObject({ kind: "refuse", status: 403 });
	});

	it("a draft, a missing sale and a locked private sale are not found [LIVE-access] [SM-2-visibility]", async () => {
		const draft = await sale("unlisted", "draft");
		const visitor = { user: buyer, unlockCookie: undefined };
		expect(await liveUpgrade(deps(), visitor, draft, upgradeHeaders(), ORIGIN)).toMatchObject({
			status: 404,
		});
		expect(
			(await liveUpgrade(deps(), { user: seller, unlockCookie: undefined }, draft, upgradeHeaders(), ORIGIN))
				.kind,
		).toBe("forward");
		expect(await liveUpgrade(deps(), visitor, "missing", upgradeHeaders(), ORIGIN)).toMatchObject({
			status: 404,
		});

		const hidden = await sale("private");
		const passwordHash = "pbkdf2$1$x$y";
		await setPrivateAccess(db, hidden, { passwordHash, allowlist: null }, now);
		expect(await liveUpgrade(deps(), visitor, hidden, upgradeHeaders(), ORIGIN)).toMatchObject({
			status: 404,
		});
		// The browser that entered the password gets in.
		const unlockCookie = await unlockToken(SECRET, hidden, passwordHash);
		expect(
			(await liveUpgrade(deps(), { user: buyer, unlockCookie }, hidden, upgradeHeaders(), ORIGIN)).kind,
		).toBe("forward");
	});
});

describe("the first render's snapshot", () => {
	const snapshot = {
		serverNow: now,
		sale: { status: "live", liveAt: now, closesAt: null, at: now },
		items: [],
	};

	it("is the engine's projection, or null when the engine can't answer", async () => {
		const calls: unknown[] = [];
		const engine = {
			liveSnapshot: async (input: unknown) => {
				calls.push(input);
				return { ok: true, value: snapshot };
			},
		} as unknown as LiveBinding;
		expect(await liveSnapshotFor(engine, "s1", "buyer")).toEqual(snapshot);
		expect(calls).toEqual([{ saleId: "s1", viewerId: "buyer" }]);

		expect(await liveSnapshotFor(undefined, "s1", null)).toBeNull();
		const failing = { liveSnapshot: async () => ({ ok: false, error: { name: "Error", message: "x" } }) };
		expect(await liveSnapshotFor(failing as unknown as LiveBinding, "s1", null)).toBeNull();
		const throwing = {
			liveSnapshot: async () => {
				throw new Error("no engine");
			},
		};
		expect(await liveSnapshotFor(throwing as unknown as LiveBinding, "s1", null)).toBeNull();
	});
});
