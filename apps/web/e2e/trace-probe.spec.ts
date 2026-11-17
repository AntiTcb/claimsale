import { expect, test } from "./fixtures.ts";

// The T28 observability spike (TECH_STACK §4): one request through
// web → RPC → engine → Durable Object → D1 → Queue. Runs locally, on previews and on
// staging after each deploy; production returns 404 and only runs @critical tests.
test.describe("trace probe", () => {
	test("crosses every hop and returns its trace IDs", async ({ request }) => {
		const res = await request.post("/api/debug/trace-probe", { data: {} });
		expect(res.status()).toBe(200);
		const body = (await res.json()) as {
			web: { traceId: string };
			engine: { traceId: string; queued: boolean; runtime: Record<string, boolean> };
		};
		expect(res.headers()["x-trace-id"]).toBe(body.web.traceId);
		expect(body.web.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(body.engine).toMatchObject({ queued: true, traceId: expect.stringMatching(/^[0-9a-f]{32}$/) });
		test.info().annotations.push({ type: "runtime", description: JSON.stringify(body.engine.runtime) });
	});

	test("returns a deliberate engine defect as a 502 with a trace ID", async ({ request }) => {
		const res = await request.post("/api/debug/trace-probe", { data: { fail: true } });
		expect(res.status()).toBe(502);
		expect(await res.json()).toMatchObject({
			stage: "engine",
			error: expect.stringContaining("deliberate failure"),
		});
	});

	test("rejects a malformed request", async ({ request }) => {
		const res = await request.post("/api/debug/trace-probe", { data: { fail: "yes" } });
		expect(res.status()).toBe(400);
		expect(await res.json()).toMatchObject({ stage: "request" });
	});

	test("the debug page runs the probe from the browser", async ({ page, expectAccessible }) => {
		await page.goto("/debug/trace");
		await expect(page.getByRole("heading", { name: "Trace probe" })).toBeVisible();
		await expectAccessible();
		await page.getByRole("button", { name: "Run probe", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Result (HTTP 200)" })).toBeVisible();
		await expect(page.getByTestId("probe-result")).toContainText('"queued": true');
	});

	// Regression (flaky under load): a click on the server-rendered button before the page
	// hydrated did nothing, so no result ever appeared. Holding back the app's JavaScript
	// makes that race deterministic; the button now stays disabled until hydration.
	test("a click before hydration isn't lost", async ({ page }) => {
		const { promise: held, resolve: release } = Promise.withResolvers<void>();
		await page.route("**/_app/immutable/**", async (route) => {
			await held;
			await route.continue();
		});
		await page.goto("/debug/trace", { waitUntil: "commit" });
		const button = page.getByRole("button", { name: "Run probe", exact: true });
		await expect(button).toBeDisabled();
		const clicked = button.click();
		release();
		await clicked;
		await expect(page.getByRole("heading", { name: "Result (HTTP 200)" })).toBeVisible();
	});
});
