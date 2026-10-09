import { expect, test } from "./fixtures.ts";

// Exercises the whole local stack: web Worker → RPC → engine Worker → D1 + Durable Object.
test("health endpoint reports both Workers healthy @critical", async ({ request }) => {
	const res = await request.get("/api/health");
	expect(res.status()).toBe(200);
	expect(res.headers()["cache-control"]).toBe("no-store");
	expect(await res.json()).toMatchObject({
		status: "ok",
		service: "web",
		engine: { status: "ok", service: "engine", checks: { d1: "ok", durableObject: "ok" } },
	});
});
