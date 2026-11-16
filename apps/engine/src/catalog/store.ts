import { Data, Effect } from "effect";
import type { PriceRow, ProductRow, SetRow } from "./mapping.ts";

/**
 * D1 writes for the catalog ingestion. Every write is an idempotent upsert that only
 * touches a row when a value changed, so re-running a build writes nothing (and the
 * FTS triggers don't fire). Rows are packed into multi-row statements under D1's
 * 100-bound-parameter limit, and statements go to D1 in `db.batch()` calls (one
 * query each against the per-invocation limit, and atomic).
 */

/** D1 allows at most 100 bound parameters per statement. */
export const MAX_PARAMS = 100;
/** Statements per `db.batch()` call. */
export const BATCH_STATEMENTS = 50;

/**
 * Upserts return one row per row inserted or updated. D1's `meta.changes` can't be used
 * to count them: it includes the rows the FTS triggers write.
 */
const RETURNING = "RETURNING 1 AS written";

export class CatalogDbError extends Data.TaggedError("CatalogDbError")<{
	readonly operation: string;
	readonly cause: unknown;
}> {
	override get message() {
		return `catalog D1 ${this.operation} failed: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
	}
}

export function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Rows per multi-row statement for a row of `width` parameters. */
export const rowsPerStatement = (width: number) => Math.floor(MAX_PARAMS / width);

const values = (rows: number, width: number) =>
	Array.from({ length: rows }, () => `(${Array.from({ length: width }, () => "?").join(", ")})`).join(", ");

export function setStatements(db: D1Database, gameId: string, sets: ReadonlyArray<SetRow>, now: number) {
	const width = 6;
	return chunk(sets, rowsPerStatement(width)).map((rows) =>
		db
			.prepare(
				`INSERT INTO catalog_sets (game_id, code, name, release_date, tcgplayer_group_id, updated_at)
				VALUES ${values(rows.length, width)}
				ON CONFLICT (tcgplayer_group_id) DO UPDATE SET
					game_id = excluded.game_id, code = excluded.code, name = excluded.name,
					release_date = excluded.release_date, updated_at = excluded.updated_at
				WHERE catalog_sets.game_id IS NOT excluded.game_id OR catalog_sets.code IS NOT excluded.code
					OR catalog_sets.name IS NOT excluded.name OR catalog_sets.release_date IS NOT excluded.release_date
				${RETURNING}`,
			)
			.bind(...rows.flatMap((s) => [gameId, s.code, s.name, s.releaseDate, s.tcgplayerGroupId, now])),
	);
}

export function productStatements(
	db: D1Database,
	gameId: string,
	setId: number,
	products: ReadonlyArray<ProductRow>,
	now: number,
) {
	const width = 9;
	return chunk(products, rowsPerStatement(width)).map((rows) =>
		db
			.prepare(
				`INSERT INTO catalog_products
					(game_id, set_id, kind, name, number, rarity, product_type, tcgplayer_product_id, updated_at)
				VALUES ${values(rows.length, width)}
				ON CONFLICT (tcgplayer_product_id) DO UPDATE SET
					game_id = excluded.game_id, set_id = excluded.set_id, kind = excluded.kind,
					name = excluded.name, number = excluded.number, rarity = excluded.rarity,
					product_type = excluded.product_type, updated_at = excluded.updated_at
				WHERE catalog_products.game_id IS NOT excluded.game_id OR catalog_products.set_id IS NOT excluded.set_id
					OR catalog_products.kind IS NOT excluded.kind OR catalog_products.name IS NOT excluded.name
					OR catalog_products.number IS NOT excluded.number OR catalog_products.rarity IS NOT excluded.rarity
					OR catalog_products.product_type IS NOT excluded.product_type
				${RETURNING}`,
			)
			.bind(
				...rows.flatMap((p) => [
					gameId,
					setId,
					p.kind,
					p.name,
					p.number,
					p.rarity,
					p.productType,
					p.tcgplayerProductId,
					now,
				]),
			),
	);
}

/**
 * Latest price per product + subtype. `as_of` moves only when the value changes; the
 * set's `synced_at` says when it was last confirmed. Prices for products not in the
 * catalog are dropped by the join.
 */
export function priceStatements(db: D1Database, prices: ReadonlyArray<PriceRow>, asOf: number) {
	const width = 4;
	return chunk(prices, rowsPerStatement(width)).map((rows) =>
		db
			.prepare(
				`INSERT INTO market_prices (product_id, subtype, market_cents, as_of)
				SELECT p.id, v.column2, v.column3, v.column4
				FROM (VALUES ${values(rows.length, width)}) AS v
				JOIN catalog_products p ON p.tcgplayer_product_id = v.column1
				WHERE true
				ON CONFLICT (product_id, subtype) DO UPDATE SET
					market_cents = excluded.market_cents, as_of = excluded.as_of
				WHERE market_prices.market_cents IS NOT excluded.market_cents
				${RETURNING}`,
			)
			.bind(...rows.flatMap((p) => [p.tcgplayerProductId, p.subtype, p.marketCents, asOf])),
	);
}

/** Runs statements in batches; returns how many rows the upserts wrote (their RETURNING rows). */
export const runBatches = (
	db: D1Database,
	operation: string,
	statements: ReadonlyArray<D1PreparedStatement>,
): Effect.Effect<number, CatalogDbError> =>
	Effect.forEach(chunk(statements, BATCH_STATEMENTS), (batch) =>
		Effect.tryPromise({
			try: () => db.batch(batch),
			catch: (cause) => new CatalogDbError({ operation, cause }),
		}),
	).pipe(Effect.map((results) => results.flat().reduce((sum, r) => sum + (r.results?.length ?? 0), 0)));

export const query = <T>(operation: string, statement: D1PreparedStatement) =>
	Effect.tryPromise({
		try: () => statement.all<T>(),
		catch: (cause) => new CatalogDbError({ operation, cause }),
	}).pipe(Effect.map((r) => r.results));

export const exec = (operation: string, statement: D1PreparedStatement) =>
	Effect.tryPromise({
		try: () => statement.run(),
		catch: (cause) => new CatalogDbError({ operation, cause }),
	}).pipe(Effect.map((r) => r.meta.changes ?? 0));
