/**
 * Spec traceability (TESTING §2): every rule ID that source code claims to
 * implement (`@spec RULE-ID`) must exist in the registry (STATE_MACHINES §10)
 * and must have at least one test whose name contains `[RULE-ID]`.
 *
 * Usage: node scripts/check-spec-traceability.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".svelte-kit", ".wrangler", "dist", "build", "coverage", ".git"]);
const ID = /[A-Z]+(?:-[A-Za-z0-9.]+)+/;

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}

const registry = readFileSync(join(root, "docs/STATE_MACHINES.md"), "utf8");
const section = registry.slice(registry.indexOf("## 10. Rule ID registry"));
const active = new Set<string>();
const retired = new Set<string>();
for (const line of section.split("\n")) {
	const struck = line.match(/^\|\s*~~`([^`]+)`~~/);
	const live = line.match(/^\|\s*`([^`]+)`\s*\|/);
	if (struck?.[1]) retired.add(struck[1]);
	else if (live?.[1]) active.add(live[1]);
}

const isTest = (p: string) => /\.(test|spec)\.ts$/.test(p);
const claimed = new Map<string, string[]>();
const tested = new Set<string>();
for (const path of walk(join(root, "apps"))
	.toArray()
	.concat(walk(join(root, "packages")).toArray())) {
	if (!/\.(ts|svelte)$/.test(path)) continue;
	const text = readFileSync(path, "utf8");
	if (isTest(path)) {
		for (const m of text.matchAll(new RegExp(`\\[(${ID.source})\\]`, "g"))) tested.add(m[1]!);
	} else {
		for (const m of text.matchAll(new RegExp(`@spec\\s+(${ID.source})`, "g"))) {
			claimed.set(m[1]!, [...(claimed.get(m[1]!) ?? []), relative(root, path)]);
		}
	}
}

const problems: string[] = [];
for (const [id, files] of claimed) {
	if (retired.has(id)) problems.push(`${id} is retired but still claimed by ${files.join(", ")}`);
	else if (!active.has(id)) problems.push(`${id} (claimed by ${files.join(", ")}) is not in the registry`);
	else if (!tested.has(id))
		problems.push(`${id} is implemented in ${files.join(", ")} but no test name contains [${id}]`);
}
for (const id of tested) {
	if (!active.has(id) && !retired.has(id))
		problems.push(`A test references [${id}], which is not in the registry`);
}

console.log(
	`Spec traceability: ${claimed.size} of ${active.size} registered rules implemented, all checked.`,
);
if (problems.length > 0) {
	console.error(problems.map((p) => `  ✗ ${p}`).join("\n"));
	process.exit(1);
}
