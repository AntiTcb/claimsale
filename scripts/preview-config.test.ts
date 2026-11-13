import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs preview-config.ts against copies of the real wrangler configs, in a temp dir,
// and checks the per-PR pair it writes (TECH_STACK T30).
const root = join(import.meta.dirname, "..");
let dir: string;
let engine: Record<string, unknown>;
let web: Record<string, unknown>;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "preview-config-"));
	for (const app of ["engine", "web"]) {
		mkdirSync(join(dir, "apps", app), { recursive: true });
		cpSync(join(root, "apps", app, "wrangler.jsonc"), join(dir, "apps", app, "wrangler.jsonc"));
	}
	execFileSync(
		process.execPath,
		[join(root, "scripts/preview-config.ts"), "--pr", "42", "--d1-id", "d1-uuid", "--version", "abc123"],
		{
			cwd: dir,
			stdio: "pipe",
		},
	);
	const read = (app: string) =>
		JSON.parse(readFileSync(join(dir, "apps", app, "wrangler.preview.jsonc"), "utf8")) as Record<
			string,
			unknown
		>;
	engine = read("engine");
	web = read("web");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("preview-config", () => {
	it("names the pair after the PR and drops the deployed environments", () => {
		expect(engine["name"]).toBe("claimsale-engine-pr-42");
		expect(web["name"]).toBe("claimsale-web-pr-42");
		expect(engine["env"]).toBeUndefined();
		expect(web["env"]).toBeUndefined();
		expect(web["services"]).toEqual([{ binding: "ENGINE", service: "claimsale-engine-pr-42" }]);
	});

	it("gives both Workers the PR's own database and the engine its own queue, with no cron", () => {
		const d1 = [
			{
				binding: "DB",
				database_name: "claimsale-pr-42",
				database_id: "d1-uuid",
				migrations_dir: "../../packages/db/migrations",
			},
		];
		expect(engine["d1_databases"]).toEqual(d1);
		expect(web["d1_databases"]).toEqual(d1);
		expect(engine["queues"]).toMatchObject({
			producers: [{ binding: "NOTIFICATIONS", queue: "claimsale-notifications-pr-42" }],
		});
		expect(engine["triggers"]).toEqual({ crons: [] });
	});

	it("copies staging's vars, with preview's APP_ENV and VERSION, and captures web email", () => {
		expect(engine["vars"]).toMatchObject({
			APP_ENV: "preview",
			VERSION: "abc123",
			MAIL_FROM: expect.any(String),
			SENTRY_DSN: "",
		});
		expect(web["vars"]).toMatchObject({ APP_ENV: "preview", VERSION: "abc123", MAILER: "capture" });
		expect(web["secrets"]).toEqual({ required: ["BETTER_AUTH_SECRET"] });
	});
});
