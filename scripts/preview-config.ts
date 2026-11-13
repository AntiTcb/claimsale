/**
 * Writes wrangler.preview.jsonc for both Workers of one PR preview pair
 * (TECH_STACK T30): claimsale-engine-pr-<n> + claimsale-web-pr-<n>, with the PR's
 * own D1 database and queue. Based on each Worker's top-level (local) config.
 *
 * Usage: node scripts/preview-config.ts --pr 123 --d1-id <uuid> --version <git sha>
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readWranglerConfig } from "./wrangler-config.ts";

const { values } = parseArgs({
	options: { pr: { type: "string" }, "d1-id": { type: "string" }, version: { type: "string" } },
});
const pr = values.pr;
const d1Id = values["d1-id"];
if (!pr || !/^\d+$/.test(pr) || !d1Id) {
	console.error("Usage: node scripts/preview-config.ts --pr <number> --d1-id <uuid> [--version <sha>]");
	process.exit(2);
}
const suffix = `pr-${pr}`;
const previewVars = { APP_ENV: "preview", VERSION: values.version ?? "preview" };

/** Staging's vars (e.g. SENTRY_DSN, MAIL_FROM), with the preview's own APP_ENV and VERSION. */
function varsFrom(config: object): Record<string, unknown> {
	const staging = (config as { env?: { staging?: { vars?: Record<string, unknown> } } }).env?.staging;
	return { ...staging?.vars, ...previewVars };
}
const queue = `claimsale-notifications-${suffix}`;

const engine = readWranglerConfig("apps/engine/wrangler.jsonc");
const engineVars = varsFrom(engine);
delete engine.env;
Object.assign(engine, {
	name: `claimsale-engine-${suffix}`,
	workers_dev: true,
	vars: engineVars,
	d1_databases: [
		{
			binding: "DB",
			database_name: `claimsale-${suffix}`,
			database_id: d1Id,
			migrations_dir: "../../packages/db/migrations",
		},
	],
	queues: {
		producers: [{ binding: "NOTIFICATIONS", queue }],
		consumers: [{ queue, max_batch_size: 25, max_retries: 5 }],
	},
	// No cron in previews; tests advance timers through the test-only endpoint instead.
	triggers: { crons: [] },
});

const web = readWranglerConfig("apps/web/wrangler.jsonc");
const webVars = varsFrom(web);
delete web.env;
Object.assign(web, {
	name: `claimsale-web-${suffix}`,
	workers_dev: true,
	// The pair has its own database, so email can be captured for E2E (MAILER, TECH_STACK §10).
	vars: { ...webVars, MAILER: "capture" },
	services: [{ binding: "ENGINE", service: `claimsale-engine-${suffix}` }],
	d1_databases: engine.d1_databases,
});

writeFileSync("apps/engine/wrangler.preview.jsonc", JSON.stringify(engine, null, "\t") + "\n");
writeFileSync("apps/web/wrangler.preview.jsonc", JSON.stringify(web, null, "\t") + "\n");
console.log(`Wrote preview configs for ${suffix}`);
