import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@claimsale/db";
import { describe, expect, it } from "vitest";
import { testD1 } from "../../../test/d1.ts";
import { addUser } from "../../../test/fixtures.ts";
import { toExisting } from "./import.ts";
import { addItem } from "./items.ts";
import { createDraft } from "./sales.ts";

// The apply path runs in the engine; its IO-import-* tests are in
// apps/engine/test/sale-import.workers.test.ts.

describe("toExisting", () => {
	it("reads stored items the way the import planner compares them", async () => {
		const db = createDb(testD1());
		await addUser(db, "seller");
		const sale = await createDraft(
			db,
			{ id: "seller", tier: "free" },
			{ title: "S", descriptionMd: "", visibility: "unlisted" },
			1,
		);
		if (!sale.ok) throw new Error("setup");
		const fields = {
			title: "Mat",
			priceCents: 2000,
			quantity: 1,
			gameId: "none",
			kind: "accessory" as const,
			condition: null,
			attributes: { accessory_type: "playmat", nested: 1 },
		};
		const added = await addItem(db, { id: "seller", tier: "free" }, sale.value.id, fields, 1);
		if (!added.ok) throw new Error("setup");
		expect(
			toExisting({
				...added.value,
				offersMode: "on_min",
				attributes: { ...added.value.attributes, bad: { x: 1 } },
			}),
		).toEqual({
			id: added.value.id,
			sku: null,
			game: null,
			kind: "accessory",
			title: "Mat",
			description: "",
			priceCents: 2000,
			quantity: 1,
			offers: "min",
			minOfferCents: null,
			shippingOverrideCents: null,
			attributes: { accessory_type: "playmat", nested: 1 },
		});
		expect(toExisting({ ...added.value, gameId: "pokemon" }).game).toBe("pokemon");
		expect(toExisting({ ...added.value, gameId: "other" }).game).toBeNull();
	});
});

describe("migration 0007_io_jobs", () => {
	const MIGRATIONS = join(import.meta.dirname, "../../../../../packages/db/migrations");
	const statements = readFileSync(join(MIGRATIONS, "0007_io_jobs.sql"), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^--.*$/gm, "").trim())
		.filter(Boolean);

	it("only adds tables and indexes (expand step)", () => {
		expect(statements.length).toBeGreaterThan(0);
		for (const statement of statements) expect(statement).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) /i);
	});

	it("applies on top of the previous schema without touching existing data", () => {
		const sqlite = new DatabaseSync(":memory:");
		const files = [
			"0000_init",
			"0001_auth",
			"0002_sales_items",
			"0003_catalog",
			"0004_catalog_search",
			"0005_games_registry",
			"0006_engine_write_path",
		];
		const run = (file: string) => {
			for (const s of readFileSync(join(MIGRATIONS, `${file}.sql`), "utf8").split("--> statement-breakpoint"))
				if (s.trim()) sqlite.exec(s);
		};
		for (const file of files) run(file);
		sqlite.exec(
			"INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES ('u1', 'a@example.test', 'A', 1, 1)",
		);
		run("0007_io_jobs");
		expect(sqlite.prepare("SELECT id FROM users").all()).toEqual([{ id: "u1" }]);
		expect(sqlite.prepare("SELECT count(*) AS n FROM io_jobs").get()).toEqual({ n: 0 });
	});
});
