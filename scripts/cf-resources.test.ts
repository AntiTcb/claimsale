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
  "workers list") echo '[{"name":"claimsale-web-pr-3","id":"w-123"},{"name":"claimsale-engine-pr-3","id":"w-456"}]' ;;
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
		expect(calls()).toEqual(["workers list"]);
	});
});

describe("cf-resources.sh delete-preview-pair", () => {
	// Regression: the engine consumes the PR's queue, and the API refuses to delete a
	// Worker that is a queue consumer (10064), so the queue must go before the engine
	// (manual cleanups of PRs #3 and #4 failed this way).
	it("deletes web, then the queue, then the engine, then D1", () => {
		run("delete-preview-pair", "3");
		expect(calls().filter((c) => c.includes(" delete "))).toEqual([
			"workers delete w-123 --force",
			"queues delete q-123 --force",
			"workers delete w-456 --force",
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
