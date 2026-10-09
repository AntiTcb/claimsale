/**
 * Prints the subset of a Doppler JSON download (stdin) that one Worker declares in
 * its wrangler config's `secrets.required` (TECH_STACK §5: per-Worker allowlists).
 *
 * Usage: doppler secrets download --no-file --format json | node scripts/secrets-for.ts apps/web/wrangler.jsonc [env]
 */
import { readFileSync } from "node:fs";
import { readWranglerConfig } from "./wrangler-config.ts";

const [path, envName] = process.argv.slice(2);
if (!path) {
	console.error("Usage: node scripts/secrets-for.ts <wrangler.jsonc> [env] < doppler.json");
	process.exit(2);
}
const config = readWranglerConfig(path);
const scoped = envName ? ((config.env?.[envName] ?? {}) as Record<string, unknown>) : config;
const required =
	((scoped["secrets"] ?? config["secrets"]) as { required?: string[] } | undefined)?.required ?? [];

const all = JSON.parse(readFileSync(0, "utf8")) as Record<string, string>;
const missing = required.filter((name) => !(name in all));
if (missing.length > 0) {
	console.error(`Doppler is missing secrets required by ${path}: ${missing.join(", ")}`);
	process.exit(1);
}
console.log(JSON.stringify(Object.fromEntries(required.map((name) => [name, all[name]]))));
