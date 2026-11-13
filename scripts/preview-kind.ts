/**
 * Decides which kind of preview a pull request gets (TECH_STACK S37):
 *
 * - "web": every changed file belongs to the web app or is documentation. The PR gets a
 *   Cloudflare Worker Preview of claimsale-web-staging, bound to the staging engine.
 * - "pair": anything else (engine, core, db, observability, dependencies, CI, scripts).
 *   The PR gets its own isolated engine + web + D1 + queue (T30), because a Worker Preview
 *   cannot bind to a Preview of another Worker, consume a queue or run a cron.
 *
 * When in doubt the answer is "pair", the isolated one.
 *
 * Usage: git diff --name-only <base> <head> | node scripts/preview-kind.ts
 */
import { readFileSync } from "node:fs";

export type PreviewKind = "web" | "pair";

const webOnly = (file: string): boolean =>
	(file.startsWith("apps/web/") && !file.startsWith("apps/web/wrangler.preview")) ||
	file.startsWith("docs/") ||
	/^[^/]+\.md$/.test(file);

export function previewKind(changedFiles: readonly string[]): PreviewKind {
	const files = changedFiles.map((f) => f.trim()).filter((f) => f.length > 0);
	return files.length > 0 && files.every(webOnly) ? "web" : "pair";
}

if (import.meta.main) {
	console.log(previewKind(readFileSync(0, "utf8").split("\n")));
}
