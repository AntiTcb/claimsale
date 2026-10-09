import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Locally, point at a preinstalled Chromium (CHROMIUM_EXECUTABLE); CI installs Playwright's own.
const executablePath = process.env["CHROMIUM_EXECUTABLE"];

// Every project except the engine's Workers tests, which run on Vitest 4.1 for now
// (see pnpm-workspace.yaml, catalog "workers-test").
export default defineConfig({
	test: {
		projects: [
			"packages/*",
			{
				extends: "./apps/web/vite.config.ts",
				test: {
					name: "web-server",
					root: "./apps/web",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.svelte.test.ts"],
					environment: "node",
				},
			},
			{
				extends: "./apps/web/vite.config.ts",
				test: {
					name: "web-browser",
					root: "./apps/web",
					include: ["src/**/*.svelte.test.ts"],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
		coverage: {
			provider: "v8",
			// Routes and packages/db are exercised by the E2E and Workers suites instead.
			include: ["packages/*/src/**/*.ts", "apps/web/src/lib/**/*.{ts,svelte}"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "packages/db/**"],
			thresholds: {
				"packages/core/src/**": { lines: 95, branches: 95 },
				"packages/observability/src/**": { lines: 85, branches: 80 },
				"apps/web/src/lib/server/**": { lines: 85, branches: 80 },
				"apps/web/src/lib/components/**": { lines: 70, branches: 60 },
			},
		},
	},
});
