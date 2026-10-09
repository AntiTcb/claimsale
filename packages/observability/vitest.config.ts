import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "observability",
		include: ["src/**/*.test.ts"],
	},
});
