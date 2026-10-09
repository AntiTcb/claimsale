/** Reads a wrangler.jsonc exactly as Wrangler does (comments, trailing commas). */
import { createRequire } from "node:module";

export type WranglerConfig = Record<string, unknown> & { env?: Record<string, unknown> };

// Resolve wrangler from the engine package, which depends on it.
const require = createRequire(new URL("../apps/engine/package.json", import.meta.url));
const wrangler = (await import(require.resolve("wrangler"))) as {
	experimental_readRawConfig: (args: { config: string }) => { rawConfig: WranglerConfig };
};

export function readWranglerConfig(path: string): WranglerConfig {
	return structuredClone(wrangler.experimental_readRawConfig({ config: path }).rawConfig);
}
