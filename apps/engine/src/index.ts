import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import {
	CATALOG_CRON,
	catalogCron,
	CatalogSearchInput,
	ingestOneGame,
	MarketPriceInput,
	searchCatalog,
	sellerMarketPrices,
	type CatalogSearchHit,
	type IngestCatalogInput,
	type IngestSummary,
	type MarketPriceView,
} from "./catalog/index.ts";
import type { EngineEnv } from "./env.ts";
import { handleQueue, handleScheduled } from "./handlers.ts";
import { health, type HealthReport } from "./health.ts";
import { CloudflareMailer } from "./mailer.ts";
import {
	requestVerification,
	requeueStalePhotos,
	reviewPhoto,
	workerDecoder,
	type PhotoReviewInput,
	type PhotoVerificationInput,
} from "./photos/index.ts";
import { fromRpcResult, optionalSecret, run, runForRpc, type RpcResult } from "./runtime.ts";
import { disabledProbe, isProbeEnabled, type TraceProbeInput, type TraceProbeResult } from "./trace-probe.ts";

export { SaleEngine } from "./sale-engine.ts";
export type { HealthReport } from "./health.ts";
export type { EngineEnv } from "./env.ts";
export type { RpcResult, RuntimeCapabilities } from "./runtime.ts";
export type { TraceProbeInput, TraceProbeResult } from "./trace-probe.ts";
export type { PhotoReviewInput, PhotoVerificationInput } from "./photos/index.ts";
export type {
	CatalogSearchHit,
	CatalogSearchInput,
	IngestCatalogInput,
	IngestSummary,
	MarketPriceInput,
	MarketPriceView,
} from "./catalog/index.ts";

/**
 * The engine Worker. The web Worker calls its methods over Workers RPC through a
 * service binding (TECH_STACK S3); it has no public routes.
 */
export default class Engine extends WorkerEntrypoint<EngineEnv> {
	override async fetch(): Promise<Response> {
		return new Response("Not found", { status: 404 });
	}

	async health(): Promise<HealthReport> {
		return run(this.env, "engine.health", health(this.env));
	}

	/** The T28 observability spike; see trace-probe.ts. */
	async traceProbe(input: TraceProbeInput): Promise<RpcResult<TraceProbeResult>> {
		if (!isProbeEnabled(this.env)) return disabledProbe;
		const stub = this.env.SALE_ENGINE.get(this.env.SALE_ENGINE.idFromName("__trace_probe__"));
		const callDurableObject = async (): Promise<RpcResult<TraceProbeResult>> => await stub.traceProbe(input);
		// A failed result is the Durable Object's defect, already reported there, so
		// it stays a failure here: one bug, one Sentry issue (see runForRpc()).
		return runForRpc(
			this.env,
			"engine.trace_probe",
			Effect.promise(callDurableObject).pipe(Effect.flatMap(fromRpcResult)),
		);
	}

	/** The seller's catalog type-ahead (autofill fields only, no prices). */
	async searchCatalog(input: CatalogSearchInput): Promise<RpcResult<ReadonlyArray<CatalogSearchHit>>> {
		return runForRpc(
			this.env,
			"engine.catalog.search",
			Schema.decodeUnknownEffect(CatalogSearchInput)(input).pipe(
				Effect.flatMap((decoded) => searchCatalog(this.env.DB, decoded)),
			),
		);
	}

	/**
	 * Market prices for a catalog product, for a seller's price placeholder (D64).
	 * The web Worker passes the authenticated viewer; non-sellers get a failure.
	 */
	async catalogMarketPrices(input: MarketPriceInput): Promise<RpcResult<MarketPriceView>> {
		return runForRpc(
			this.env,
			"engine.catalog.market_prices",
			Schema.decodeUnknownEffect(MarketPriceInput)(input).pipe(
				Effect.flatMap((decoded) => sellerMarketPrices(this.env.DB, decoded)),
			),
		);
	}

	/** Runs the catalog ingestion for one game now (admin, or staging on demand). */
	async ingestCatalog(input: IngestCatalogInput): Promise<RpcResult<IngestSummary>> {
		return runForRpc(this.env, "engine.catalog.ingest", ingestOneGame(this.env, input));
	}

	/** Queues the duplicate check of a new upload (photo authenticity, WS-F2). */
	async requestPhotoVerification(input: PhotoVerificationInput): Promise<RpcResult<true>> {
		return runForRpc(this.env, "engine.photos.request", requestVerification(this.env.NOTIFICATIONS, input));
	}

	/** An admin approves or rejects a photo held for review; false if it wasn't in review. */
	async reviewPhoto(input: PhotoReviewInput): Promise<RpcResult<boolean>> {
		return runForRpc(this.env, "engine.photos.review", reviewPhoto(this.env.DB, input));
	}

	override async queue(batch: MessageBatch): Promise<void> {
		const options = {
			probeRecipient: optionalSecret(this.env, "TRACE_PROBE_TO"),
			photos: { db: this.env.DB, images: this.env.IMAGES, decode: workerDecoder() },
		};
		await run(
			this.env,
			"engine.queue.notifications",
			handleQueue(batch, options).pipe(Effect.provide(CloudflareMailer(this.env.EMAIL, this.env.MAIL_FROM))),
		);
	}

	override async scheduled(controller: ScheduledController): Promise<void> {
		if (controller.cron === CATALOG_CRON) {
			await run(this.env, "engine.cron.catalog", catalogCron(this.env));
			return;
		}
		await run(this.env, "engine.cron.sweep", handleScheduled(controller));
		await run(this.env, "engine.cron.photos", requeueStalePhotos(this.env));
	}
}
