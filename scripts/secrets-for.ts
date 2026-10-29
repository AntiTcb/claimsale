/**
 * Prints the subset of a JSON object of secrets (stdin; in CI, the GitHub Environment's
 * `toJSON(secrets)`) that one Worker declares in its wrangler config's `secrets.required`
 * (TECH_STACK S35: per-Worker allowlists).
 *
 * Usage: node scripts/secrets-for.ts apps/web/wrangler.jsonc [env] < secrets.json
 */
import { readFileSync } from "node:fs";
import { readWranglerConfig } from "./wrangler-config.ts";

const [path, envName] = process.argv.slice(2);
if (!path) {
	console.error("Usage: node scripts/secrets-for.ts <wrangler.jsonc> [env] < secrets.json");
	process.exit(2);
}
const config = readWranglerConfig(path);
const scoped = envName ? ((config.env?.[envName] ?? {}) as Record<string, unknown>) : config;
const required =
	((scoped["secrets"] ?? config["secrets"]) as { required?: string[] } | undefined)?.required ?? [];

const all = JSON.parse(readFileSync(0, "utf8")) as Record<string, string>;
const missing = required.filter((name) => !(name in all));
if (missing.length > 0) {
	console.error(`Missing secrets required by ${path}: ${missing.join(", ")}`);
	process.exit(1);
}
console.log(JSON.stringify(Object.fromEntries(required.map((name) => [name, all[name]]))));
