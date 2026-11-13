/**
 * Prints, as JSON, the secrets one Worker declares in its wrangler config's `secrets.required`
 * (TECH_STACK S35: per-Worker allowlists), read from environment variables of the same name.
 * CI sets those by name from the GitHub Environment on the deploy step. Workflows never pass
 * `toJSON(secrets)`: GitHub flags that as possibly malicious and holds every run for approval.
 *
 * With --previews, reads the env's `previews.secrets.required` instead, for a Worker Preview
 * (TECH_STACK S37). Previews inherit nothing from the Worker's own settings, so there is no
 * fallback to the top-level list.
 *
 * Usage: node scripts/secrets-for.ts apps/web/wrangler.jsonc [env] [--previews]
 */
import { parseArgs } from "node:util";
import { readWranglerConfig } from "./wrangler-config.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { previews: { type: "boolean", default: false } },
});
const [path, envName] = positionals;
if (!path) {
	console.error("Usage: node scripts/secrets-for.ts <wrangler.jsonc> [env] [--previews]");
	process.exit(2);
}
type Secrets = { required?: string[] } | undefined;
const config = readWranglerConfig(path);
const scoped = envName ? ((config.env?.[envName] ?? {}) as Record<string, unknown>) : config;
const required = values.previews
	? (((scoped["previews"] as Record<string, unknown> | undefined)?.["secrets"] as Secrets)?.required ?? [])
	: (((scoped["secrets"] ?? config["secrets"]) as Secrets)?.required ?? []);

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
	console.error(
		`Missing secrets required by ${path}: ${missing.join(", ")}. Set them by name on the deploy step.`,
	);
	process.exit(1);
}
console.log(JSON.stringify(Object.fromEntries(required.map((name) => [name, process.env[name]]))));
