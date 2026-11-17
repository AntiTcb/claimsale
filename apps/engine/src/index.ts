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
import { fromRpcResult, optionalSecret, run, runForRpc, type RpcResult } from "./runtime.ts";
import { disabledProbe, isProbeEnabled, type TraceProbeInput, type TraceProbeResult } from "./trace-probe.ts";
import type { InvoiceView, ItemCommandResult, Outcome, SaleView } from "./sale-engine.ts";
import { saleCommand } from "./sale/entrypoint.ts";
import type { ImportBatchResult } from "./sale/import.ts";
import * as rpc from "./sale/rpc.ts";
import { sweepTimers } from "./sale/sweep.ts";

export { SaleEngine } from "./sale-engine.ts";
export type { InvoiceView, ItemCommandResult, Outcome, SaleView, SweepReport } from "./sale-engine.ts";
export type { ImportBatchResult, ImportRowResult } from "./sale/import.ts";
export type * as SaleRpc from "./sale/rpc.ts";
export type { HealthReport } from "./health.ts";
export type { EngineEnv } from "./env.ts";
export type { RpcResult, RuntimeCapabilities } from "./runtime.ts";
export type { TraceProbeInput, TraceProbeResult } from "./trace-probe.ts";
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

	// -------------------------------------------------------------------------
	// Sale write path (STATE_MACHINES §9): each method validates its input and runs the
	// command in the sale's SaleEngine. The outer RpcResult fails only on a defect or
	// invalid input; a rule saying no is an `{ ok: false, error: { code, message } }` Outcome.

	/** A buyer claims or offers (§4.1). Rate-limited per buyer. */
	async placeEntry(input: rpc.PlaceEntryInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.PlaceEntryInput, "place", input, (decoded) => decoded.buyerId);
	}

	/** A buyer withdraws an offer or leaves the backup queue (§4.4). */
	async withdrawEntry(input: rpc.BuyerEntryInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.BuyerEntryInput, "withdraw", input);
	}

	async respondToCounter(input: rpc.CounterResponseInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.CounterResponseInput, "respondToCounter", input);
	}

	async awardEntry(input: rpc.SellerEntryInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.SellerEntryInput, "award", input);
	}

	async declineOffer(input: rpc.SellerEntryInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.SellerEntryInput, "declineOffer", input);
	}

	async counterOffer(input: rpc.CounterInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.CounterInput, "counter", input);
	}

	async reorderBackups(input: rpc.ReorderInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.ReorderInput, "reorder", input);
	}

	async withdrawItem(input: rpc.SellerItemInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.SellerItemInput, "withdrawItem", input);
	}

	/** The seller rescinds a win with a reason code, optionally passing it to the next backup (§4.3). */
	async sellerRescind(input: rpc.SellerRescindInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.SellerRescindInput, "sellerRescind", input);
	}

	/** A Pro buyer rescinds their own win before the invoice is sent (D24). */
	async buyerRescind(input: rpc.BuyerEntryInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.BuyerEntryInput, "buyerRescind", input);
	}

	async requestTakeback(input: rpc.TakebackRequestInput): Promise<RpcResult<Outcome<{ requestId: string }>>> {
		return saleCommand(this.env, rpc.TakebackRequestInput, "requestTakeback", input);
	}

	async decideTakeback(input: rpc.TakebackDecisionInput): Promise<RpcResult<Outcome<ItemCommandResult>>> {
		return saleCommand(this.env, rpc.TakebackDecisionInput, "decideTakeback", input);
	}

	async cancelTakeback(input: rpc.TakebackCancelInput): Promise<RpcResult<Outcome<{ requestId: string }>>> {
		return saleCommand(this.env, rpc.TakebackCancelInput, "cancelTakeback", input);
	}

	async publishSale(input: rpc.PublishInput): Promise<RpcResult<Outcome<SaleView>>> {
		return saleCommand(this.env, rpc.PublishInput, "publish", input);
	}

	async unpublishSale(input: rpc.SellerSaleInput): Promise<RpcResult<Outcome<SaleView>>> {
		return saleCommand(this.env, rpc.SellerSaleInput, "unpublish", input);
	}

	async closeSale(input: rpc.SellerSaleInput): Promise<RpcResult<Outcome<SaleView>>> {
		return saleCommand(this.env, rpc.SellerSaleInput, "closeBySeller", input);
	}

	async sendInvoice(input: rpc.SellerInvoiceInput): Promise<RpcResult<Outcome<InvoiceView>>> {
		return saleCommand(this.env, rpc.SellerInvoiceInput, "sendInvoice", input);
	}

	async sendAllInvoices(input: rpc.SellerSaleInput): Promise<RpcResult<Outcome<{ sent: number }>>> {
		return saleCommand(this.env, rpc.SellerSaleInput, "sendAllInvoices", input);
	}

	/** The buyer picks shipping and says "I've paid". */
	async markInvoicePaid(input: rpc.MarkPaidInput): Promise<RpcResult<Outcome<InvoiceView>>> {
		return saleCommand(this.env, rpc.MarkPaidInput, "markBuyerPaid", input);
	}

	async confirmInvoicePaid(input: rpc.SellerInvoiceInput): Promise<RpcResult<Outcome<InvoiceView>>> {
		return saleCommand(this.env, rpc.SellerInvoiceInput, "confirmPaid", input);
	}

	async invoiceNotReceived(input: rpc.SellerInvoiceInput): Promise<RpcResult<Outcome<InvoiceView>>> {
		return saleCommand(this.env, rpc.SellerInvoiceInput, "paymentNotReceived", input);
	}

	async shipInvoice(input: rpc.ShipInput): Promise<RpcResult<Outcome<InvoiceView>>> {
		return saleCommand(this.env, rpc.ShipInput, "ship", input);
	}

	/** The buyer confirms receipt. */
	async completeInvoice(input: rpc.BuyerInvoiceInput): Promise<RpcResult<Outcome<InvoiceView>>> {
		return saleCommand(this.env, rpc.BuyerInvoiceInput, "completeInvoice", input);
	}

	/** One batch (≤ 100 rows) of an item import, idempotent per (`importId`, row) (WS-G). */
	async applyImportBatch(input: rpc.ImportBatchInput): Promise<RpcResult<Outcome<ImportBatchResult>>> {
		return saleCommand(this.env, rpc.ImportBatchInput, "applyImportBatch", input);
	}

	override async queue(batch: MessageBatch): Promise<void> {
		const options = { probeRecipient: optionalSecret(this.env, "TRACE_PROBE_TO") };
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
		await run(
			this.env,
			"engine.cron.sweep",
			handleScheduled(controller).pipe(Effect.andThen(sweepTimers(this.env))),
		);
	}
}
