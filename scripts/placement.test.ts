import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWranglerConfig, type WranglerConfig } from "./wrangler-config.ts";

// Regression (TECH_STACK S42): the web Worker ran in whichever colo received the request,
// so every one of a page's sequential D1 queries crossed to the database's region. A PR pair
// served from Tokyo took ~1 s per request, and the @critical sell test ran out of its 30 s.
// The web Worker must be placed next to D1, in every deployed configuration.
const root = join(import.meta.dirname, "..");
const web = readWranglerConfig(join(root, "apps/web/wrangler.jsonc"));

/** The cloud region next to each D1 location hint we create databases with. */
const regionFor: Record<string, string> = { enam: "aws:us-east-1" };

/** The default D1 location hint in cf-resources.sh, which creates every database. */
function d1LocationHint(): string {
	const script = readFileSync(join(root, "scripts/cf-resources.sh"), "utf8");
	const hint = /cf d1 create .*--primary-location-hint "\$\{3:-(\w+)\}"/.exec(script)?.[1];
	if (!hint) throw new Error("cf-resources.sh no longer sets a D1 location hint");
	return hint;
}

const envs = web.env as Record<string, WranglerConfig & { previews?: WranglerConfig }>;

describe("web Worker placement", () => {
	const region = regionFor[d1LocationHint()];

	it("has a placement region for the D1 location hint", () => {
		expect(region).toBeDefined();
	});

	it("places the top-level config (local and PR pairs) next to D1", () => {
		expect(web["placement"]).toEqual({ region });
	});

	it.each(Object.keys(envs))("places env.%s next to D1", (name) => {
		expect(envs[name]!["placement"]).toEqual({ region });
	});

	it("places staging's Worker Previews next to D1 (previews inherit nothing)", () => {
		expect(envs["staging"]!.previews?.["placement"]).toEqual({ region });
	});
});
