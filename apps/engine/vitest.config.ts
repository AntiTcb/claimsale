import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Photo fixtures from packages/imagehash, passed to the tests as base64 bindings. */
const fixture = (name: string) =>
	readFileSync(path.join(import.meta.dirname, "../../packages/imagehash/src/fixtures", name)).toString(
		"base64",
	);

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					APP_ENV: "test",
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
		name: "engine",
		include: ["test/**/*.test.ts"],
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
