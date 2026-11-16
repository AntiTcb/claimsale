declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}

/** Vite's `?raw` imports (fixture files as text). */
declare module "*?raw" {
	const content: string;
	export default content;
}
