import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

/** Photo fixtures from packages/imagehash, passed to the tests as base64 bindings. */
const fixture = (name: string) =>
	readFileSync(path.join(import.meta.dirname, "../../packages/imagehash/src/fixtures", name)).toString(
		"base64",
	);

/**
 * The same suite once per sale store (STATE_MACHINES §9, WS-N): `engine` with each sale in
 * its SaleEngine's SQLite (the default), `engine-d1` with every sale in D1 (the rollback
 * switch), so both stay correct.
 */
const project = (name: string, store: "local" | "d1"): TestProjectInlineConfiguration => ({
	extends: false,
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					APP_ENV: "test",
					SALE_STORE: store,
					TEST_MIGRATIONS: await readD1Migrations(
						path.join(import.meta.dirname, "../../packages/db/migrations"),
					),
					TEST_PHOTOS: {
						cardA: fixture("card-a.jpg"),
						cardAWebp: fixture("card-a.webp"),
						cardB: fixture("card-b.jpg"),
					},
				},
			},
		})),
	],
	test: {
		name,
		root: import.meta.dirname,
		include: ["test/**/*.test.ts"],
		// The local store's own mechanics (outbox, hydration) only exist with the local store.
		exclude: store === "d1" ? ["test/sale-store.workers.test.ts"] : [],
		setupFiles: ["./test/apply-migrations.ts"],
	},
});

export default defineConfig({
	test: {
		projects: [project("engine", "local"), project("engine-d1", "d1")],
	},
});
