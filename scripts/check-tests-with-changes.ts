/**
 * Tests-with-changes guard (TESTING §5): a PR that changes source under apps/ or
 * packages/ must also change at least one test file, unless it carries the
 * `no-tests-needed` label (with a reason in the PR description).
 *
 * Env: BASE_REF (e.g. origin/dev), PR_LABELS (comma-separated).
 */
import { execFileSync } from "node:child_process";

const base = process.env["BASE_REF"] ?? "origin/dev";
const labels = (process.env["PR_LABELS"] ?? "").split(",").map((l) => l.trim());

const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
	.split("\n")
	.filter(Boolean);

const isTest = (f: string) => /\.(test|spec)\.ts$/.test(f) || /\/(e2e|test)\//.test(f);
const isSource = (f: string) =>
	/^(apps|packages)\//.test(f) &&
	/\.(ts|svelte)$/.test(f) &&
	!isTest(f) &&
	!/(^|\/)(worker-configuration\.d\.ts|.*\.config\.ts)$/.test(f);

const source = changed.filter(isSource);
const tests = changed.filter(isTest);

if (source.length === 0 || tests.length > 0) {
	console.log(
		`Tests-with-changes: ${source.length} source file(s), ${tests.length} test file(s) changed. OK.`,
	);
} else if (labels.includes("no-tests-needed")) {
	console.log(`Tests-with-changes: no test changes, overridden by the no-tests-needed label.`);
} else {
	console.error(
		`Source files changed without any test changes:\n${source.map((f) => `  - ${f}`).join("\n")}\n` +
			`Add or update tests (TESTING.md §2), or label the PR "no-tests-needed" and explain why in the description.`,
	);
	process.exit(1);
}
