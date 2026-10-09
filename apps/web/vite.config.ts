import adapter from "@sveltejs/adapter-cloudflare";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: adapter(),
			compilerOptions: { experimental: { async: true } },
			// TECH_STACK S2: remote functions, wrapped in our own layer when first used.
			experimental: { remoteFunctions: true },
		}),
	],
});
