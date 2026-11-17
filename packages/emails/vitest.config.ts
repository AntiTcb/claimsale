import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		name: "emails",
		include: ["src/**/*.test.ts"],
	},
});
