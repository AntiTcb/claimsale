import { Effect, Schema } from "effect";
import type { EngineEnv } from "../env.ts";
import { ingestCatalog, type IngestOptions } from "./ingest.ts";
import { TcgCsvLive } from "./tcgcsv.ts";

export { ingestCatalog, UnknownGame, type IngestSummary } from "./ingest.ts";
export {
	CatalogSearchInput,
	MarketPriceInput,
	searchCatalog,
	sellerMarketPrices,
	type CatalogSearchHit,
	type MarketPriceView,
} from "./search.ts";

/**
 * The catalog cron (TECH_STACK S32). Hourly from 21:15 to 02:15 UTC, after TCGCSV's
 * daily rebuild (~20:00 UTC): each run continues where the previous one stopped, and
 * costs one request once the build is fully ingested. Production only; staging runs
 * it on demand (`ingestCatalog` RPC) to stay well inside TCGCSV's daily request budget.
 */
export const CATALOG_CRON = "15 0-2,21-23 * * *";

const DEFAULT_GROUPS_PER_RUN = 300;

/** Sets per run from `CATALOG_GROUPS_PER_RUN`; each set costs two TCGCSV requests. */
export function groupsPerRun(env: Pick<EngineEnv, "CATALOG_GROUPS_PER_RUN">): number {
	const value = Number.parseInt(env.CATALOG_GROUPS_PER_RUN, 10);
	return Number.isInteger(value) && value >= 0 ? value : DEFAULT_GROUPS_PER_RUN;
}

export const catalogSourceLayer = (env: Pick<EngineEnv, "TCGCSV_BASE_URL">, fetchImpl?: typeof fetch) =>
	TcgCsvLive({ baseUrl: env.TCGCSV_BASE_URL, ...(fetchImpl ? { fetch: fetchImpl } : {}) });

/** The cron's run over every enabled game. */
export const catalogCron = (env: EngineEnv) =>
	ingestCatalog(env.DB, { maxGroups: groupsPerRun(env) }).pipe(Effect.provide(catalogSourceLayer(env)));

export const IngestCatalogInput = Schema.Struct({
	game: Schema.String,
	force: Schema.optional(Schema.Boolean),
	maxGroups: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2000 }))),
});
export type IngestCatalogInput = typeof IngestCatalogInput.Type;

/** An on-demand run for one game (admin / staging). */
export const ingestOneGame = (env: EngineEnv, input: unknown) =>
	Effect.gen(function* () {
		const { game, force, maxGroups } = yield* Schema.decodeUnknownEffect(IngestCatalogInput)(input);
		const options: IngestOptions = {
			game,
			maxGroups: maxGroups ?? groupsPerRun(env),
			...(force === undefined ? {} : { force }),
		};
		return yield* ingestCatalog(env.DB, options).pipe(Effect.provide(catalogSourceLayer(env)));
	});
