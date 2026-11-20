import { createDb, type Db } from "@claimsale/db";
import { isRedirect } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser, grantSellerPro, memoryStore } from "../../../test/fixtures.ts";
import type { SessionUser } from "./auth.ts";

// The routes read bindings through context.ts (`cloudflare:workers`); here they get a
// real schema on node:sqlite instead.
let database: Db;
vi.mock("#lib/server/context.ts", () => ({
	db: () => database,
	imageStore: () => memoryStore(),
}));

const { requireSeller } = await import("./sell.ts");

/** Every /sell route module WS-A added; each `load` and action must go through the gate. */
const ROUTES = {
	"/sell": await import("../../routes/sell/+page.server.ts"),
	"/sell/new": await import("../../routes/sell/new/+page.server.ts"),
	"/sell/[saleId] (layout)": await import("../../routes/sell/[saleId]/+layout.server.ts"),
	"/sell/[saleId]": await import("../../routes/sell/[saleId]/+page.server.ts"),
	"/sell/[saleId]/terms": await import("../../routes/sell/[saleId]/terms/+page.server.ts"),
	"/sell/[saleId]/items": await import("../../routes/sell/[saleId]/items/+page.server.ts"),
	"/sell/[saleId]/import": await import("../../routes/sell/[saleId]/import/+page.server.ts"),
};

type TestUser = SessionUser;

const ready: TestUser = {
	id: "u1",
	email: "u1@example.test",
	name: "User u1",
	createdAt: new Date("2026-11-01T00:00:00Z"),
	updatedAt: new Date("2026-11-01T00:00:00Z"),
	emailVerified: true,
	ageAttested: "18+",
};

function event(user: TestUser | null, path = "/sell/new") {
	const body = new FormData();
	return {
		locals: { user, session: null },
		url: new URL(`http://x${path}`),
		params: { saleId: "no-such-sale" },
		request: new Request(`http://x${path}`, { method: "POST", body }),
		cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
		parent: async () => ({}),
		setHeaders: () => undefined,
	};
}

async function outcome(run: () => unknown): Promise<string> {
	try {
		await run();
		return "passed the gate";
	} catch (error) {
		if (isRedirect(error)) return `${error.status} ${error.location.split("?")[0]}`;
		// A 404 for the made-up sale means the gate let the seller through.
		return "passed the gate";
	}
}

/** Every load and action of every /sell route, run as `user`. */
async function sweep(user: TestUser | null): Promise<Record<string, string>> {
	const results: Record<string, string> = {};
	for (const [route, module] of Object.entries(ROUTES)) {
		const handlers: Record<string, unknown> = {
			load: "load" in module ? module.load : undefined,
			...("actions" in module ? module.actions : {}),
		};
		for (const [name, handler] of Object.entries(handlers)) {
			if (typeof handler !== "function") continue;
			// oxlint-disable-next-line no-await-in-loop -- one handler at a time, against one database
			results[`${route} ${name}`] = await outcome(() => handler(event(user)));
		}
	}
	return results;
}

beforeEach(async () => {
	database = createDb(testD1());
	await addUser(database, "u1");
});

describe("the seller gate on /sell (D55)", () => {
	it("[AUTH-seller-requirements] every /sell load and action sends an unready seller to the checklist", async () => {
		const results = await sweep({ ...ready, emailVerified: false });
		expect(Object.keys(results).length).toBeGreaterThanOrEqual(12);
		for (const [handler, result] of Object.entries(results)) {
			expect(`${handler}: ${result}`).toBe(`${handler}: 303 /sell/requirements`);
		}
		const signedOut = await sweep(null);
		for (const [handler, result] of Object.entries(signedOut)) {
			expect(`${handler}: ${result}`).toBe(`${handler}: 303 /login`);
		}
	});

	it("[AUTH-seller-requirements] each missing requirement blocks, and a ready seller gets through", async () => {
		for (const user of [
			{ ...ready, ageAttested: "13+" },
			{ ...ready, ageAttested: null },
			{ ...ready, emailVerified: false },
		]) {
			// oxlint-disable-next-line no-await-in-loop -- one case at a time
			expect(await outcome(() => requireSeller(event(user)))).toBe("303 /sell/requirements");
		}
		expect(await requireSeller(event(ready))).toEqual({ id: "u1", tier: "free" });
		const results = await sweep(ready);
		for (const [handler, result] of Object.entries(results)) {
			expect(`${handler}: ${result}`).not.toContain("/sell/requirements");
		}
	});

	it("[AUTH-seller-requirements] Pro sellers need a verified email and 18+ too", async () => {
		await grantSellerPro(database, "u1");
		expect(await requireSeller(event(ready))).toEqual({ id: "u1", tier: "pro" });
		expect(await outcome(() => requireSeller(event({ ...ready, emailVerified: false })))).toBe(
			"303 /sell/requirements",
		);
	});

	it("[AUTH-seller-requirements] photo uploads refuse an unready seller with 403", async () => {
		const { POST } = await import("../../routes/api/uploads/+server.ts");
		const upload = (user: TestUser) =>
			POST({
				...event(user, "/api/uploads?sale=s1&item=i1"),
				request: new Request("http://x/api/uploads?sale=s1&item=i1", {
					method: "POST",
					body: new Uint8Array([1, 2, 3]),
				}),
			} as never);
		expect((await upload({ ...ready, emailVerified: false })).status).toBe(403);
		// A ready seller gets past the gate (and on to "no such item").
		expect((await upload(ready)).status).toBe(404);
	});

	it("keeps where the seller was going", async () => {
		const error: unknown = await requireSeller(
			event({ ...ready, emailVerified: false }, "/sell/abc/items?wizard=1"),
		).catch((e: unknown) => e);
		expect(isRedirect(error) && error.location).toBe(
			"/sell/requirements?next=%2Fsell%2Fabc%2Fitems%3Fwizard%3D1",
		);
	});
});
