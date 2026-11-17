import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "imagehash",
		include: ["src/**/*.test.ts"],
		// The robustness properties encode, decode and hash dozens of images per test.
		testTimeout: 60_000,
	},
});
