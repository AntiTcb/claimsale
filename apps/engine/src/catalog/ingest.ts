import { Clock, Data, Effect } from "effect";
import { parseTcgCsvTime, toPriceRow, toProductRow, toSetRow, type PriceRow } from "./mapping.ts";
import {
	CatalogDbError,
	exec,
	priceStatements,
	productStatements,
	query,
	runBatches,
	setStatements,
} from "./store.ts";
import { TcgCsvSource } from "./tcgcsv.ts";

/**
 * Nightly TCGCSV ingestion (TECH_STACK S32, PLAN M4b): games → groups (sets) →
 * products → prices, for enabled games.
 *
 * A run is resumable. Each set remembers the TCGCSV build it was last ingested from,
 * so a run first refreshes the group list of every game not yet read for the current
 * build, then ingests up to `maxGroups` sets that are behind it, newest first. The
 * cron fires several times after TCGCSV's daily rebuild; once everything is current a
 * run costs one request (`last-updated.txt`). Failures stay behind and are retried by
 * the next run.
 *
 * @spec TCG-catalog-ingest — idempotent (re-ingesting a build writes no rows) and
 * resumable; only autofill fields and the latest market price are stored.
 */

export interface IngestOptions {
	/** Restrict the run to one game (by id / slug). */
	readonly game?: string;
	/** Re-ingest every set of `game` even if it is current for this build. */
	readonly force?: boolean;
	/** Most sets (groups) to ingest in this run; each costs two requests. */
	readonly maxGroups: number;
	/** Sets ingested at once. TCGCSV asks for gentle request rates. */
	readonly concurrency?: number;
}

export interface IngestSummary {
	readonly build: string;
	readonly upToDate: boolean;
	readonly games: number;
	readonly gamesFailed: number;
	readonly setsWritten: number;
	readonly groupsIngested: number;
	readonly groupsFailed: number;
	/** Sets still behind the build after this run. */
	readonly groupsRemaining: number;
	readonly productsWritten: number;
	readonly pricesWritten: number;
	readonly requests: number;
	readonly durationMs: number;
}

export class UnknownGame extends Data.TaggedError("UnknownGame")<{ readonly game: string }> {
	override get message() {
		return `No enabled game with id ${this.game}`;
	}
}

interface GameRow {
	readonly id: string;
	readonly tcgplayer_category_id: number;
	readonly synced_build: string | null;
}

interface StaleSet {
	readonly id: number;
	readonly game_id: string;
	readonly tcgplayer_group_id: number;
	readonly tcgplayer_category_id: number;
}

const staleSetsFilter = (game: string | undefined) => `
	FROM catalog_sets s JOIN games g ON g.id = s.game_id
	WHERE g.enabled = 1 AND g.tcgplayer_category_id IS NOT NULL
		AND (s.synced_build IS NULL OR s.synced_build <> ?1)
		${game === undefined ? "" : "AND g.id = ?2"}`;

const bindFilter = (statement: D1PreparedStatement, build: string, game: string | undefined) =>
	game === undefined ? statement.bind(build) : statement.bind(build, game);

/** Reads one game's group list and upserts its sets. */
const refreshGame = (db: D1Database, game: GameRow, build: string) =>
	Effect.gen(function* () {
		const source = yield* TcgCsvSource;
		const groups = yield* source.groups(game.tcgplayer_category_id);
		const now = yield* Clock.currentTimeMillis;
		return yield* runBatches(db, "upsert sets", [
			...setStatements(db, game.id, groups.map(toSetRow), now),
			db.prepare("UPDATE games SET synced_build = ?, synced_at = ? WHERE id = ?").bind(build, now, game.id),
		]);
	}).pipe(Effect.withSpan("catalog.refresh_game", { attributes: { game: game.id } }));

/** Ingests one set's products and prices, then marks it current for `build`. */
const ingestSet = (db: D1Database, set: StaleSet, build: string) =>
	Effect.gen(function* () {
		const source = yield* TcgCsvSource;
		const products = yield* source.products(set.tcgplayer_category_id, set.tcgplayer_group_id);
		const prices = yield* source.prices(set.tcgplayer_category_id, set.tcgplayer_group_id);
		const now = yield* Clock.currentTimeMillis;
		const asOf = parseTcgCsvTime(build) ?? now;

		// Product IDs appear once per set; the last one wins if TCGplayer repeats one.
		const productRows = [...new Map(products.map((p) => [p.productId, toProductRow(p)])).values()];
		const priceRows = [
			...new Map(
				prices
					.map(toPriceRow)
					.filter((p): p is PriceRow => p !== null)
					.map((p) => [`${p.tcgplayerProductId}|${p.subtype}`, p]),
			).values(),
		];

		const productsWritten = yield* runBatches(
			db,
			"upsert products",
			productStatements(db, set.game_id, set.id, productRows, now),
		);
		const pricesWritten = yield* runBatches(db, "upsert prices", [
			...priceStatements(db, priceRows, asOf),
			db
				.prepare("UPDATE catalog_sets SET synced_build = ?, synced_at = ? WHERE id = ?")
				.bind(build, now, set.id),
		]);
		return { productsWritten, pricesWritten };
	}).pipe(
		Effect.withSpan("catalog.ingest_set", {
			attributes: { game: set.game_id, tcgplayer_group_id: set.tcgplayer_group_id },
		}),
	);

export const ingestCatalog = (db: D1Database, options: IngestOptions) =>
	Effect.gen(function* () {
		const source = yield* TcgCsvSource;
		const startedAt = yield* Clock.currentTimeMillis;
		const build = yield* source.lastUpdated;
		yield* Effect.annotateCurrentSpan({ build, game: options.game ?? "all" });

		const games = yield* query<GameRow>(
			"read games",
			options.game === undefined
				? db.prepare(
						"SELECT id, tcgplayer_category_id, synced_build FROM games WHERE enabled = 1 AND tcgplayer_category_id IS NOT NULL ORDER BY sort_order",
					)
				: db
						.prepare(
							"SELECT id, tcgplayer_category_id, synced_build FROM games WHERE enabled = 1 AND tcgplayer_category_id IS NOT NULL AND id = ?",
						)
						.bind(options.game),
		);
		if (options.game !== undefined && games.length === 0) {
			return yield* new UnknownGame({ game: options.game });
		}
		const force = options.force === true && options.game !== undefined;
		if (force && options.game !== undefined) {
			yield* exec(
				"reset sets",
				db.prepare("UPDATE catalog_sets SET synced_build = NULL WHERE game_id = ?").bind(options.game),
			);
		}

		let setsWritten = 0;
		let gamesFailed = 0;
		for (const game of games.filter((g) => force || g.synced_build !== build)) {
			const outcome = yield* refreshGame(db, game, build).pipe(Effect.result);
			if (outcome._tag === "Success") setsWritten += outcome.success;
			else {
				gamesFailed += 1;
				yield* Effect.logWarning("catalog: reading a game's sets failed; retried next run").pipe(
					Effect.annotateLogs({ game: game.id, error: outcome.failure.message }),
				);
			}
		}

		const stale = yield* query<StaleSet>(
			"read stale sets",
			bindFilter(
				db.prepare(
					`SELECT s.id, s.game_id, s.tcgplayer_group_id, g.tcgplayer_category_id ${staleSetsFilter(options.game)}
					ORDER BY s.release_date DESC NULLS LAST, s.id LIMIT ${Math.max(0, Math.floor(options.maxGroups))}`,
				),
				build,
				options.game,
			),
		);

		const results = yield* Effect.forEach(
			stale,
			(set) =>
				ingestSet(db, set, build).pipe(
					Effect.tapError((error) =>
						Effect.logWarning("catalog: ingesting a set failed; retried next run").pipe(
							Effect.annotateLogs({
								game: set.game_id,
								tcgplayer_group_id: set.tcgplayer_group_id,
								error: error.message,
							}),
						),
					),
					Effect.result,
				),
			{ concurrency: options.concurrency ?? 2 },
		);

		const counted = yield* query<{ remaining: number }>(
			"count stale sets",
			bindFilter(
				db.prepare(`SELECT count(*) AS remaining ${staleSetsFilter(options.game)}`),
				build,
				options.game,
			),
		);
		const remaining = counted[0]?.remaining ?? 0;

		let productsWritten = 0;
		let pricesWritten = 0;
		let groupsIngested = 0;
		for (const result of results) {
			if (result._tag !== "Success") continue;
			groupsIngested += 1;
			productsWritten += result.success.productsWritten;
			pricesWritten += result.success.pricesWritten;
		}
		const summary: IngestSummary = {
			build,
			upToDate: stale.length === 0 && games.every((g) => g.synced_build === build) && !force,
			games: games.length,
			gamesFailed,
			setsWritten,
			groupsIngested,
			groupsFailed: results.length - groupsIngested,
			groupsRemaining: remaining,
			productsWritten,
			pricesWritten,
			requests: yield* source.requestCount,
			durationMs: (yield* Clock.currentTimeMillis) - startedAt,
		};
		yield* Effect.logInfo("catalog ingestion finished").pipe(
			Effect.annotateLogs({
				build: summary.build,
				up_to_date: summary.upToDate,
				games: summary.games,
				games_failed: summary.gamesFailed,
				sets_written: summary.setsWritten,
				groups_ingested: summary.groupsIngested,
				groups_failed: summary.groupsFailed,
				groups_remaining: summary.groupsRemaining,
				products_written: summary.productsWritten,
				prices_written: summary.pricesWritten,
				requests: summary.requests,
				duration_ms: summary.durationMs,
			}),
		);
		return summary;
	}).pipe(Effect.withSpan("catalog.ingest"));

export type IngestError = CatalogDbError | UnknownGame;
