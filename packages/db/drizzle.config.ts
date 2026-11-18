import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	// The catalog tables (WS-C) live in their own file to keep merges with the core tables simple.
	schema: ["./src/schema.ts", "./src/catalog.ts", "./src/photos.ts", "./src/messaging.ts"],
	out: "./migrations",
});
