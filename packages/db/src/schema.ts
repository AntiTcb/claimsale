import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Milestone 0 only: a key/value table the health check reads to prove the D1
 * binding and migrations work end to end. Domain tables arrive with their
 * milestones (PLAN §6).
 */
export const appMeta = sqliteTable("app_meta", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});
