import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { previewKind } from "./preview-kind.ts";

describe("previewKind", () => {
	it("gives web-only changes a Worker Preview", () => {
		expect(previewKind(["apps/web/src/routes/+page.svelte", "apps/web/e2e/home.test.ts"])).toBe("web");
	});

	it("treats docs and root markdown as web-safe", () => {
		expect(previewKind(["apps/web/src/app.css", "docs/PLAN.md", "README.md"])).toBe("web");
	});

	it.each([
		"apps/engine/src/index.ts",
		"packages/core/src/sale.ts",
		"packages/db/migrations/0002_x.sql",
		"packages/observability/src/log.ts",
		"pnpm-lock.yaml",
		"package.json",
		".github/workflows/preview.yml",
		"scripts/preview-config.ts",
		"apps/web/wrangler.preview.jsonc",
		"apps/engine/README.md",
	])("needs an isolated pair when %s changes", (file) => {
		expect(previewKind(["apps/web/src/app.css", file])).toBe("pair");
	});

	it("falls back to the isolated pair when nothing is known to have changed", () => {
		expect(previewKind([])).toBe("pair");
		expect(previewKind(["", "  "])).toBe("pair");
	});

	it("reads the file list from stdin", () => {
		const out = execFileSync("node", [join(import.meta.dirname, "preview-kind.ts")], {
			input: "apps/web/src/app.css\ndocs/TESTING.md\n",
			encoding: "utf8",
		});
		expect(out.trim()).toBe("web");
	});
});
