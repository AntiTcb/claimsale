import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "cf-resources.sh");

// A fake `cf` that logs its arguments and answers list commands with one matching row,
// shaped like the real CLI's JSON output.
const fakeCf = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CF_LOG"
case "$1 $2" in
  "workers list")
    # Paginated like the real API: page 1 holds 100 other Workers, page 2 the PR's.
    if [ "\${4:-1}" = "1" ]; then
      seq 1 100 | jq -sc 'map({name: "other-\\(.)", id: "o-\\(.)"})'
    else
      echo '[{"name":"claimsale-web-pr-3","id":"w-123"},{"name":"claimsale-engine-pr-3","id":"w-456"}]'
    fi ;;
  "queues consumers") [ "$3" = "list" ] && echo '[{"consumer_id":"c-123","script":"claimsale-engine-pr-3"}]' || echo '{}' ;;
  "queues list")  echo '[{"queue_name":"claimsale-notifications-pr-3","queue_id":"q-123"}]' ;;
  "d1 list")      echo '[{"name":"claimsale-pr-3","uuid":"d-123"}]' ;;
  "d1 create"|"queues create") echo '{}' ;;
  *) echo '{}' ;;
esac
`;

let dir: string;
let log: string;

function run(...args: string[]): string {
	return execFileSync("bash", [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, CF_BIN: join(dir, "cf"), CF_LOG: log },
	});
}

const calls = () => readFileSync(log, "utf8").trim().split("\n");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cf-resources-"));
	log = join(dir, "calls.log");
	writeFileSync(log, "");
	writeFileSync(join(dir, "cf"), fakeCf);
	chmodSync(join(dir, "cf"), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cf-resources.sh deletes without prompting", () => {
	// Regression: without --force, cf asks for confirmation and aborts in CI
	// (PR preview cleanup for PR #3 failed this way).
	it("deletes a Worker by ID with --force", () => {
		run("delete-worker", "claimsale-web-pr-3");
		expect(calls()).toContain("workers delete w-123 --force");
	});

	it("deletes a queue by ID with --force", () => {
		run("delete-queue", "claimsale-notifications-pr-3");
		expect(calls()).toContain("queues delete q-123 --force");
	});

	it("deletes a D1 database by ID with --force", () => {
		run("delete-d1", "claimsale-pr-3");
		expect(calls()).toContain("d1 delete d-123 --force");
	});

	it("does nothing when the resource doesn't exist", () => {
		run("delete-worker", "claimsale-web-pr-999");
		expect(calls()).toEqual(["workers list --page 1 --per-page 100", "workers list --page 2 --per-page 100"]);
	});

	// Regression: `cf workers list` returns one page (10 Workers by default); with more
	// Workers in the account, a preview's Worker could be missed and never deleted.
	it("finds a Worker beyond the first page of the list", () => {
		run("delete-worker", "claimsale-engine-pr-3");
		expect(calls()).toContain("workers delete w-456 --force");
	});
});

describe("cf-resources.sh delete-preview-pair", () => {
	// Regression: the engine consumes and produces to the PR's queue. The API refuses to
	// delete a Worker that consumes a queue (10064) and a queue a Worker binds to (11005);
	// manual cleanups of PRs #3 and #4 failed on each in turn.
	it("deletes web, detaches the queue's consumer, then deletes engine, queue and D1", () => {
		run("delete-preview-pair", "3");
		expect(calls().filter((c) => c.includes(" delete "))).toEqual([
			"workers delete w-123 --force",
			"queues consumers delete c-123 --queue-id q-123 --force",
			"workers delete w-456 --force",
			"queues delete q-123 --force",
			"d1 delete d-123 --force",
		]);
	});

	it("rejects anything but a PR number", () => {
		expect(() => run("delete-preview-pair", "3; rm -rf /")).toThrow(/Command failed/);
		expect(calls()).toEqual([""]);
	});
});

describe("cf-resources.sh ensure commands are idempotent", () => {
	it("returns an existing D1 database's ID without creating one", () => {
		expect(run("ensure-d1", "claimsale-pr-3").trim()).toBe("d-123");
		expect(calls().some((c) => c.startsWith("d1 create"))).toBe(false);
	});

	it("does not create a queue that already exists", () => {
		run("ensure-queue", "claimsale-notifications-pr-3");
		expect(calls()).toEqual(["queues list"]);
	});
});
