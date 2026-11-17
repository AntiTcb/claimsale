import { reject, type Millis, type Rejection, type Result, type SaleStatus } from "@claimsale/core";
import type { Outcome, RpcResult } from "@claimsale/engine";

/**
 * The web Worker's view of the sale engine (STATE_MACHINES §9). Every sale
 * transition goes through the SaleEngine Durable Object over Workers RPC: the engine
 * runs the core transition under the sale's lock, sets the server time, writes D1 and
 * the audit row in one batch, and owns the alarm at `live_at` / `closes_at`.
 */

export interface PublishRequest {
	readonly saleId: string;
	readonly sellerId: string;
	/** Null publishes now (SM-2-publish-now). */
	readonly liveAt: Millis | null;
	readonly closesAt: Millis;
}

/** A rule said no (the engine's code and message), or the engine didn't answer. */
export type EngineRejection = Rejection;

export interface PublishOutcome {
	readonly status: SaleStatus;
	readonly liveAt: Millis | null;
	readonly closesAt: Millis | null;
}

export interface Engine {
	publish(request: PublishRequest): Promise<Result<PublishOutcome, EngineRejection>>;
	unpublish(request: { saleId: string; sellerId: string }): Promise<Result<PublishOutcome, EngineRejection>>;
	close(request: { saleId: string; sellerId: string }): Promise<Result<PublishOutcome, EngineRejection>>;
}

/** The engine methods this module calls (the `ENGINE` service binding has them all). */
export type EngineBinding = Pick<Env["ENGINE"], "publishSale" | "unpublishSale" | "closeSale">;

const unavailable = () =>
	reject("engine_unavailable", "The sale engine didn't answer. Try again in a moment.");

/** Unwraps the RPC layer: a defect on the engine's side becomes a retryable rejection. */
function settle<A>(result: RpcResult<Outcome<A>>): Result<A, EngineRejection> {
	if (!result.ok) return unavailable();
	return result.value;
}

const outcome = (sale: PublishOutcome): PublishOutcome => ({
	status: sale.status,
	liveAt: sale.liveAt,
	closesAt: sale.closesAt,
});

/**
 * The engine over RPC. Every publish check runs in the engine's command, including the
 * photo checks (IMG-required, IMG-timestamp-required), so the web Worker only passes
 * requests through.
 */
export function rpcEngine(binding: EngineBinding): Engine {
	return {
		/**
		 * The engine enforces SM-2-publish-scheduled, SM-2-publish-now, SM-2-preview-window,
		 * SM-2-max-duration, SM-2-free-sale-cap, SM-2-free-item-cap and the photo checks.
		 */
		async publish(request) {
			const result = settle(
				(await binding.publishSale({
					saleId: request.saleId,
					sellerId: request.sellerId,
					liveAt: request.liveAt,
					closesAt: request.closesAt,
				})) as RpcResult<Outcome<PublishOutcome>>,
			);
			return result.ok ? { ok: true, value: outcome(result.value) } : result;
		},

		async unpublish(request) {
			const result = settle(
				(await binding.unpublishSale({ saleId: request.saleId, sellerId: request.sellerId })) as RpcResult<
					Outcome<PublishOutcome>
				>,
			);
			return result.ok ? { ok: true, value: outcome(result.value) } : result;
		},

		async close(request) {
			const result = settle(
				(await binding.closeSale({ saleId: request.saleId, sellerId: request.sellerId })) as RpcResult<
					Outcome<PublishOutcome>
				>,
			);
			return result.ok ? { ok: true, value: outcome(result.value) } : result;
		},
	};
}
