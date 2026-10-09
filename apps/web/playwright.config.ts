import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env["CI"];
// Locally, a preinstalled Chromium can be used (CHROMIUM_EXECUTABLE); CI installs Playwright's browsers.
const executablePath = process.env["CHROMIUM_EXECUTABLE"];
const chromiumLaunch = executablePath ? { launchOptions: { executablePath } } : {};
// E2E_BASE_URL targets a deployed preview or staging; otherwise both Workers run locally.
const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:8787";
const persist = "../../.wrangler/e2e";
// Previews and staging sit behind Cloudflare Access; CI authenticates with a service token.
const accessId = process.env["E2E_ACCESS_CLIENT_ID"];
const accessSecret = process.env["E2E_ACCESS_CLIENT_SECRET"];
const extraHTTPHeaders: Record<string, string> =
	accessId && accessSecret
		? { "CF-Access-Client-Id": accessId, "CF-Access-Client-Secret": accessSecret }
		: {};

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: CI,
	// One retry in CI only; anything that passes on retry is reported as flaky (TESTING §6).
	retries: CI ? 1 : 0,
	reporter: CI ? [["github"], ["html", { open: "never" }]] : "list",
	use: { baseURL, extraHTTPHeaders, trace: "retain-on-failure" },
	projects: [
		{ name: "chromium-desktop", use: { ...devices["Desktop Chrome"], ...chromiumLaunch } },
		{ name: "chromium-mobile", grep: /@critical/, use: { ...devices["Pixel 7"], ...chromiumLaunch } },
		...(executablePath
			? []
			: [{ name: "webkit-mobile", grep: /@critical/, use: { ...devices["iPhone 15"] } }]),
		// Firefox runs nightly (TESTING §4).
		...(process.env["E2E_ALL_BROWSERS"]
			? [{ name: "firefox-desktop", grep: /@critical/, use: { ...devices["Desktop Firefox"] } }]
			: []),
	],
	...(process.env["E2E_BASE_URL"]
		? {}
		: {
				// Both Workers in one wrangler process: web is primary, engine is bound by name.
				webServer: {
					command:
						`(cd ../engine && wrangler d1 migrations apply DB --local --persist-to ${persist}) && ` +
						`vite build && wrangler dev -c wrangler.jsonc -c ../engine/wrangler.jsonc ` +
						`--port 8787 --inspector-port 9231 --persist-to ${persist}`,
					url: "http://localhost:8787/",
					reuseExistingServer: !CI,
					timeout: 180_000,
				},
			}),
});
