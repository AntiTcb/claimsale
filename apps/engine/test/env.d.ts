declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
		/** Base64 photo fixtures from packages/imagehash/src/fixtures (vitest.config.ts). */
		TEST_PHOTOS: { cardA: string; cardAWebp: string; cardB: string };
	}
}

/** Vite's `?raw` imports (fixture files as text). */
declare module "*?raw" {
	const content: string;
	export default content;
}
