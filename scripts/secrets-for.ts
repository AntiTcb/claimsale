/**
 * Prints, as JSON, the secrets one Worker declares in its wrangler config's `secrets.required`
 * (TECH_STACK S35: per-Worker allowlists), read from environment variables of the same name.
 * CI sets those by name from the GitHub Environment on the deploy step. Workflows never pass
 * `toJSON(secrets)`: GitHub flags that as possibly malicious and holds every run for approval.
 *
 * Usage: node scripts/secrets-for.ts apps/web/wrangler.jsonc [env]
 */
import { readWranglerConfig } from "./wrangler-config.ts";

const [path, envName] = process.argv.slice(2);
if (!path) {
	console.error("Usage: node scripts/secrets-for.ts <wrangler.jsonc> [env]");
	process.exit(2);
}
const config = readWranglerConfig(path);
const scoped = envName ? ((config.env?.[envName] ?? {}) as Record<string, unknown>) : config;
const required =
	((scoped["secrets"] ?? config["secrets"]) as { required?: string[] } | undefined)?.required ?? [];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
	console.error(
		`Missing secrets required by ${path}: ${missing.join(", ")}. Set them by name on the deploy step.`,
	);
	process.exit(1);
}
console.log(JSON.stringify(Object.fromEntries(required.map((name) => [name, process.env[name]]))));
