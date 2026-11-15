import { Context, Data, Duration, Effect, Layer, Schedule, Schema } from "effect";

/**
 * TCGCSV (tcgcsv.com), the only catalog source (D60, TECH_STACK S32). It mirrors
 * TCGplayer's catalog API as static JSON, rebuilt once a day. Its usage guidelines
 * ask for a descriptive User-Agent, ~100 ms between requests and at most ~10,000
 * requests a day, so requests here are spaced and the ingestion only re-reads a
 * set once per build (`last-updated.txt`).
 */

// Only the fields ClaimSale reads; unknown fields are ignored.
const ExtendedData = Schema.Struct({ name: Schema.String, value: Schema.NullOr(Schema.String) });

export const TcgCsvGroup = Schema.Struct({
	groupId: Schema.Int,
	name: Schema.String,
	abbreviation: Schema.optional(Schema.NullOr(Schema.String)),
	publishedOn: Schema.optional(Schema.NullOr(Schema.String)),
	categoryId: Schema.Int,
});
export type TcgCsvGroup = typeof TcgCsvGroup.Type;

export const TcgCsvProduct = Schema.Struct({
	productId: Schema.Int,
	name: Schema.String,
	groupId: Schema.Int,
	extendedData: Schema.optional(Schema.NullOr(Schema.Array(ExtendedData))),
});
export type TcgCsvProduct = typeof TcgCsvProduct.Type;

export const TcgCsvPrice = Schema.Struct({
	productId: Schema.Int,
	marketPrice: Schema.optional(Schema.NullOr(Schema.Number)),
	subTypeName: Schema.String,
});
export type TcgCsvPrice = typeof TcgCsvPrice.Type;

const envelope = <S extends Schema.Top>(item: S) => Schema.Struct({ results: Schema.Array(item) });

export class TcgCsvError extends Data.TaggedError("TcgCsvError")<{
	readonly path: string;
	readonly reason: "http" | "network" | "timeout" | "decode";
	readonly status?: number;
	readonly cause?: unknown;
}> {
	override get message() {
		return `TCGCSV ${this.path}: ${this.reason}${this.status === undefined ? "" : ` ${this.status}`}`;
	}
}

export class TcgCsvSource extends Context.Service<
	TcgCsvSource,
	{
		/** The build stamp from `last-updated.txt`, e.g. `2026-11-15T20:06:00+0000`. */
		readonly lastUpdated: Effect.Effect<string, TcgCsvError>;
		readonly groups: (categoryId: number) => Effect.Effect<ReadonlyArray<TcgCsvGroup>, TcgCsvError>;
		readonly products: (
			categoryId: number,
			groupId: number,
		) => Effect.Effect<ReadonlyArray<TcgCsvProduct>, TcgCsvError>;
		readonly prices: (
			categoryId: number,
			groupId: number,
		) => Effect.Effect<ReadonlyArray<TcgCsvPrice>, TcgCsvError>;
		/** Requests made so far (successful or not), for the run summary. */
		readonly requestCount: Effect.Effect<number>;
	}
>()("claimsale/engine/TcgCsvSource") {}

export const USER_AGENT = "ClaimSale-Catalog/1.0 (+https://claimsale.net)";

export interface TcgCsvOptions {
	/** e.g. `https://tcgcsv.com`; configurable per environment (`TCGCSV_BASE_URL`). */
	readonly baseUrl: string;
	readonly fetch?: typeof fetch;
	/** Pause after each request (TCGCSV asks for ~100 ms). */
	readonly spacing?: Duration.Input;
	readonly timeout?: Duration.Input;
	/** Retries after the first attempt, for network errors, timeouts and 5xx / 429. */
	readonly retries?: number;
}

const retryable = (error: TcgCsvError) =>
	error.reason === "network" ||
	error.reason === "timeout" ||
	(error.reason === "http" && (error.status === 429 || (error.status ?? 0) >= 500));

export const TcgCsvLive = (options: TcgCsvOptions) =>
	Layer.sync(TcgCsvSource, () => {
		const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
		const base = options.baseUrl.replace(/\/+$/, "");
		let requests = 0;

		const request = (path: string) =>
			Effect.gen(function* () {
				requests += 1;
				const response = yield* Effect.tryPromise({
					try: (signal) => doFetch(`${base}${path}`, { headers: { "user-agent": USER_AGENT }, signal }),
					catch: (cause) => new TcgCsvError({ path, reason: "network", cause }),
				});
				if (!response.ok) {
					// Release the connection; the body is not needed.
					yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
					return yield* new TcgCsvError({ path, reason: "http", status: response.status });
				}
				return yield* Effect.tryPromise({
					try: () => response.text(),
					catch: (cause) => new TcgCsvError({ path, reason: "network", cause }),
				});
			}).pipe(
				Effect.timeoutOrElse({
					duration: options.timeout ?? "30 seconds",
					orElse: () => Effect.fail(new TcgCsvError({ path, reason: "timeout" })),
				}),
				Effect.tap(() => Effect.sleep(options.spacing ?? "100 millis")),
				Effect.retry({
					schedule: Schedule.exponential("500 millis"),
					times: options.retries ?? 2,
					while: retryable,
				}),
				Effect.withSpan("tcgcsv.fetch", { attributes: { "tcgcsv.path": path } }),
			);

		const json = <S extends Schema.Top & { readonly DecodingServices: never }>(path: string, schema: S) =>
			request(path).pipe(
				Effect.flatMap((text) =>
					Effect.try({
						try: () => JSON.parse(text) as unknown,
						catch: (cause) => new TcgCsvError({ path, reason: "decode", cause }),
					}),
				),
				Effect.flatMap((body) =>
					Schema.decodeUnknownEffect(schema)(body).pipe(
						Effect.mapError((cause) => new TcgCsvError({ path, reason: "decode", cause })),
					),
				),
			);

		const list =
			<S extends Schema.Top & { readonly DecodingServices: never }>(item: S) =>
			(path: string) =>
				json(path, envelope(item)).pipe(Effect.map((body) => body.results));

		return TcgCsvSource.of({
			lastUpdated: request("/last-updated.txt").pipe(Effect.map((text) => text.trim())),
			groups: (categoryId) => list(TcgCsvGroup)(`/tcgplayer/${categoryId}/groups`),
			products: (categoryId, groupId) => list(TcgCsvProduct)(`/tcgplayer/${categoryId}/${groupId}/products`),
			prices: (categoryId, groupId) => list(TcgCsvPrice)(`/tcgplayer/${categoryId}/${groupId}/prices`),
			requestCount: Effect.sync(() => requests),
		});
	});
