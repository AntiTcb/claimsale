/**
 * Prints the D1 database_id bound as DB in a wrangler config (optionally for one env).
 * `cf d1 migrations apply` needs the ID, not the binding name.
 *
 * Usage: node scripts/d1-id.ts apps/engine/wrangler.jsonc [env]
 */
import { readWranglerConfig } from "./wrangler-config.ts";

const [path, envName] = process.argv.slice(2);
if (!path) {
	console.error("Usage: node scripts/d1-id.ts <wrangler.jsonc> [env]");
	process.exit(2);
}
const config = readWranglerConfig(path);
const scoped = envName ? ((config.env?.[envName] ?? {}) as Record<string, unknown>) : config;
const dbs = (scoped["d1_databases"] ?? []) as Array<{ binding: string; database_id?: string }>;
const id = dbs.find((db) => db.binding === "DB")?.database_id;
if (!id) {
	console.error(`No DB binding with a database_id in ${path}${envName ? ` (env ${envName})` : ""}`);
	process.exit(1);
}
console.log(id);
