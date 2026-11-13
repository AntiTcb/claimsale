import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "secrets-for.ts");

let dir: string;
let config: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "secrets-for-"));
	config = join(dir, "wrangler.jsonc");
	writeFileSync(
		config,
		`{
			"name": "w",
			"secrets": { "required": ["TOP"] },
			"env": {
				"staging": {
					"secrets": { "required": ["STAGING"] },
					"previews": { "secrets": { "required": ["PREVIEW"] } },
				},
				"bare": {},
			},
		}`,
	);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) =>
	JSON.parse(
		execFileSync("node", [script, config, ...args], {
			encoding: "utf8",
			env: { ...process.env, TOP: "t", STAGING: "s", PREVIEW: "p" },
		}),
	) as Record<string, string>;

describe("secrets-for", () => {
	it("reads an env's own list, falling back to the top level", () => {
		expect(run("staging")).toEqual({ STAGING: "s" });
		expect(run("bare")).toEqual({ TOP: "t" });
		expect(run()).toEqual({ TOP: "t" });
	});

	it("reads previews.secrets for a Worker Preview, without inheriting", () => {
		expect(run("staging", "--previews")).toEqual({ PREVIEW: "p" });
		expect(run("bare", "--previews")).toEqual({});
	});

	it("fails when a required secret is not set", () => {
		expect(() =>
			execFileSync("node", [script, config, "staging", "--previews"], {
				encoding: "utf8",
				stdio: "pipe",
				env: { ...process.env, PREVIEW: "" },
			}),
		).toThrow(/Missing secrets required by .*: PREVIEW/);
	});
});
