import { formatTraceparent } from "@claimsale/observability";
import { dueTimers, nextAlarm, type LiveSnapshot, type Millis, type Timer } from "@claimsale/core";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { EngineEnv } from "./env.ts";
import { LiveHub } from "./live/hub.ts";
import {
	broadcastCommit,
	broadcastRefresh,
	connectLive,
	loadLiveSnapshot,
	parseLivePath,
	revokeViewers,
	VIEWER_HEADER,
} from "./live/sale-live.ts";
import { run, runForRpc, runtimeCapabilities, type RpcResult } from "./runtime.ts";
import { KeyedLocks } from "./sale/locks.ts";
import { LOCAL_TABLES } from "@claimsale/db/local";
import { LOCAL_META_TABLES } from "./sale/local-db.ts";
import { D1SaleStorage, LocalSaleStorage, type SaleStorage } from "./sale/storage.ts";
import { loadTimers } from "./sale/timers.ts";
import type { Work } from "./sale/store.ts";
import { SaleWriter, type Outcome } from "./sale/writer.ts";
import { disabledProbe, isProbeEnabled, probeInDurableObject, type TraceProbeResult } from "./trace-probe.ts";

export type { ItemCommandResult, InvoiceView, Outcome, RescindView, SaleView } from "./sale/writer.ts";

/** How long the alarm waits before retrying a timer that is still due after it ran. */
const RETRY_DELAY: Millis = 15_000;

/** The SaleWriter methods the engine exposes, by name. */
export type WriterMethod = {
	[K in keyof SaleWriter]: SaleWriter[K] extends (input: never) => Promise<Outcome<unknown>> ? K : never;
}[keyof SaleWriter];

/**
 * Commands a buyer sends during a rush: they return as soon as the engine's own store has
 * them, and D1 follows. Every other command waits for D1, because the web Worker reads it
 * right after (invoices, the control room).
 *
 * @spec SM-9-read-your-writes
 */
export const FAST_METHODS: ReadonlySet<string> = new Set(["place", "withdraw", "respondToCounter"]);

/** `SALE_STORE`: "d1" keeps every sale in D1 (the rollback switch); anything else, the object's SQLite. */
export const storeMode = (env: Pick<EngineEnv, "SALE_STORE">): "local" | "d1" =>
	env.SALE_STORE === "d1" ? "d1" : "local";

export interface SweepReport {
	readonly processed: number;
	readonly nextAlarm: Millis | null;
}

/**
 * One instance per sale, addressed by `idFromName(saleId)` (STATE_MACHINES §9). It
 * serializes the sale's writes (per-item locks), owns the sale's single alarm (§7),
 * holds the sale page's live sockets (WS-H) and, since WS-N, the sale's own rows in its
 * SQLite (`sale/storage.ts`), which D1 follows through an outbox.
 */
export class SaleEngine extends DurableObject<EngineEnv> {
	readonly #locks = new KeyedLocks();
	readonly #live: LiveHub;
	readonly #storage: SaleStorage;
	#saleId: string | undefined;
	#writer: SaleWriter | undefined;

	constructor(ctx: DurableObjectState, env: EngineEnv) {
		super(ctx, env);
		this.#live = new LiveHub(ctx);
		const saleId = () => this.#saleId;
		if (storeMode(env) === "d1") {
			this.#storage = new D1SaleStorage(env.DB, saleId, {
				publish: (id, events) => this.#publish(id, events),
			});
			// Back from the local store: D1 gets what this object still holds, then the copy goes.
			void ctx.blockConcurrencyWhile(() => this.#retireLocalStore());
		} else {
			this.#storage = new LocalSaleStorage(
				ctx,
				env.DB,
				saleId,
				{
					send: (id, events) => this.#sendEvents(id, events),
					publish: (id, events) => this.#publish(id, events),
					waitUntil: (promise) => ctx.waitUntil(promise),
					wakeBy: (at) => this.#armAtMost(at),
					warn: (message, error) =>
						ctx.waitUntil(
							run(
								this.env,
								"engine.sale.outbox",
								Effect.logWarning(message, error).pipe(
									Effect.annotateLogs({ sale_id: this.#saleId ?? null }),
								),
							),
						),
				},
				() => this.clock(),
			);
		}
	}

	/** Leaves the d1 adapter with an empty local store: flush what's left, then drop the tables. */
	async #retireLocalStore(): Promise<void> {
		const tables = this.ctx.storage.sql
			.exec<{ n: number }>(
				"SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_outbox'",
			)
			.one().n;
		if (tables === 0) return;
		const local = new LocalSaleStorage(
			this.ctx,
			this.env.DB,
			() => this.#saleId,
			{
				send: (id, events) => this.#sendEvents(id, events),
				publish: () => undefined,
				waitUntil: () => undefined,
				wakeBy: async () => undefined,
				warn: () => undefined,
			},
			() => this.clock(),
		);
		await local.settle();
		if (local.pending() > 0) throw new Error("the local store couldn't be flushed to D1");
		for (const name of [...LOCAL_TABLES.map((t) => t.name).toReversed(), ...LOCAL_META_TABLES]) {
			this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${name}"`);
		}
	}

	/** The engine's clock: server-set milliseconds. Tests replace it through runInDurableObject. */
	clock: () => Millis = () => Date.now();

	async ping(): Promise<"pong"> {
		return "pong";
	}

	/**
	 * The sale page's live socket (`/live/<saleId>`, forwarded by the Engine entrypoint
	 * from the web Worker, which checked the session and the sale's access).
	 */
	override async fetch(request: Request): Promise<Response> {
		const saleId = parseLivePath(new URL(request.url).pathname);
		if (saleId === undefined) return new Response("Not found", { status: 404 });
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		if (!(await this.#bindSale(saleId))) return new Response("Not found", { status: 404 });
		const userId = request.headers.get(VIEWER_HEADER) || null;
		return run(
			this.env,
			"engine.live.connect",
			Effect.promise(() => connectLive(this.#live, this.#storage, saleId, userId, this.clock())),
			{ sale_id: saleId },
		);
	}

	/** Browsers only send pings, which the runtime answers (LiveHub); anything else is ignored. */
	override webSocketMessage(): void {}

	override webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	/**
	 * Runs one write command for `saleId`. The Engine entrypoint validated `input` and
	 * types the result; a rejection is a normal outcome, a defect an RpcResult failure.
	 */
	async command(saleId: string, method: WriterMethod, input: unknown): Promise<RpcResult<Outcome<unknown>>> {
		return runForRpc(
			this.env,
			`engine.sale.${method}`,
			Effect.promise(async (): Promise<Outcome<unknown>> => {
				const writer = await this.#writerFor(saleId);
				// The entrypoint decoded `input` with the schema that belongs to `method`.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				const call = writer[method] as (input: unknown) => Promise<Outcome<unknown>>;
				const outcome = await call.call(writer, input);
				// An import writes items outside the per-item commit, so its rows aren't in the diff.
				if (outcome.ok && method === "applyImportBatch") await this.#listingsChanged(saleId);
				if (outcome.ok && !FAST_METHODS.has(method)) await this.#storage.settle();
				return outcome;
			}).pipe(
				Effect.tap((outcome) =>
					outcome.ok
						? Effect.void
						: Effect.logInfo("command rejected").pipe(Effect.annotateLogs({ code: outcome.error.code })),
				),
			),
			{ sale_id: saleId, command: method },
		);
	}

	/**
	 * The seller changed items outside a command (the web item editor): open sockets get a
	 * fresh snapshot and a public sale's listings are matched against want lists again.
	 */
	async listingsChanged(saleId: string): Promise<RpcResult<boolean>> {
		return runForRpc(
			this.env,
			"engine.sale.listings_changed",
			Effect.promise(() => this.#listingsChanged(saleId)),
			{
				sale_id: saleId,
			},
		);
	}

	/** A private sale's access changed: every viewer but the seller is disconnected (LIVE-access). */
	async revokeLiveViewers(saleId: string): Promise<RpcResult<number>> {
		return runForRpc(
			this.env,
			"engine.sale.revoke_viewers",
			Effect.sync(() => revokeViewers(this.#live)),
			{
				sale_id: saleId,
			},
		);
	}

	/**
	 * Refreshes open sockets, then asks the notifications consumer to match the sale's listings
	 * against want lists again (it decides whether the sale is public and open; want-list
	 * notifications are keyed by want and item, so a listing already announced isn't again).
	 *
	 * @spec TCG-want-list-notify — items added or repriced after publishing are matched too.
	 */
	async #listingsChanged(saleId: string): Promise<boolean> {
		if (!(await this.#bindSale(saleId))) return false;
		await this.#storage.refreshItems(saleId);
		const exists = await broadcastRefresh(this.#live, this.#storage, saleId, this.clock());
		if (exists) this.#publish(saleId, [{ type: "listings_changed" }]);
		return exists;
	}

	/**
	 * Every item of the sale as one viewer may see it (the page's first render), from the
	 * engine's own store; null when the sale doesn't exist for them.
	 */
	async liveSnapshot(saleId: string, viewerId: string | null): Promise<RpcResult<LiveSnapshot | null>> {
		return runForRpc(
			this.env,
			"engine.live.snapshot",
			Effect.promise(async () => {
				if (!(await this.#bindSale(saleId))) return null;
				return (await loadLiveSnapshot(this.#storage, saleId, viewerId, this.clock())) ?? null;
			}),
			{ sale_id: saleId },
		);
	}

	/**
	 * A buyer's standing changed (blocked, unblocked, banned): the next claim reads it from D1.
	 *
	 * @spec SM-9-buyer-cache
	 */
	async forgetBuyer(userId: string): Promise<void> {
		this.#storage.forget({ buyerId: userId });
	}

	/** Waits until D1 has every write this sale committed; the entries still waiting (tests, operations). */
	async settle(saleId: string): Promise<RpcResult<number>> {
		return runForRpc(
			this.env,
			"engine.sale.settle",
			Effect.promise(async () => {
				await this.#storage.settle();
				return this.#storage instanceof LocalSaleStorage ? this.#storage.pending() : 0;
			}),
			{ sale_id: saleId },
		);
	}

	/**
	 * Drops the engine's copy of the sale and reads it from D1 again (after a D1 restore,
	 * or a repair). Pending writes go to D1 first.
	 *
	 * @spec SM-9-hydrate
	 */
	async rehydrate(saleId: string): Promise<RpcResult<boolean>> {
		return runForRpc(
			this.env,
			"engine.sale.rehydrate",
			Effect.promise(async () => {
				if (!(await this.#bindSale(saleId))) return false;
				if (this.#storage instanceof LocalSaleStorage) await this.#storage.rehydrate(saleId);
				return true;
			}),
			{ sale_id: saleId },
		);
	}

	/**
	 * Runs every due timer now, then re-arms (the cron sweep's backstop for a lost
	 * alarm, and the alarm's own body).
	 */
	async sweep(saleId: string): Promise<RpcResult<SweepReport>> {
		return runForRpc(
			this.env,
			"engine.sale.sweep",
			Effect.promise(() => this.#processTimers(saleId)),
			{
				sale_id: saleId,
			},
		);
	}

	/**
	 * The sale's single alarm.
	 *
	 * @spec SM-7-single-alarm — it processes everything due, then re-arms at the earliest pending timer.
	 */
	override async alarm(): Promise<void> {
		const saleId = await this.#knownSaleId();
		await run(
			this.env,
			"engine.sale.alarm",
			saleId === undefined
				? Effect.logInfo("sale engine alarm fired").pipe(
						Effect.annotateLogs({ durable_object_id: this.ctx.id.toString(), sale_id: null }),
					)
				: Effect.promise(() => this.#processTimers(saleId)).pipe(
						Effect.tap((report) =>
							Effect.logInfo("sale engine alarm fired").pipe(
								Effect.annotateLogs({
									sale_id: saleId,
									processed: report.processed,
									next_alarm: report.nextAlarm,
								}),
							),
						),
					),
		);
	}

	/** The Durable Object hop of the T28 trace probe. */
	async traceProbe(input: unknown): Promise<RpcResult<TraceProbeResult>> {
		if (!isProbeEnabled(this.env)) return disabledProbe;
		return runForRpc(
			this.env,
			"engine.trace_probe.durable_object",
			probeInDurableObject(this.env, input, runtimeCapabilities()),
		);
	}

	async #knownSaleId(): Promise<string | undefined> {
		this.#saleId ??= await this.ctx.storage.get<string>("saleId");
		return this.#saleId;
	}

	/** Remembers the sale this instance serves; false if it serves another one. */
	async #bindSale(saleId: string): Promise<boolean> {
		const known = await this.#knownSaleId();
		if (known === undefined) {
			await this.ctx.storage.put("saleId", saleId);
			this.#saleId = saleId;
			return true;
		}
		return known === saleId;
	}

	async #writerFor(saleId: string): Promise<SaleWriter> {
		if (!(await this.#bindSale(saleId))) {
			throw new Error(`this SaleEngine serves sale ${this.#saleId}, not ${saleId}`);
		}
		await this.#storage.ready(saleId);
		this.#writer ??= new SaleWriter(
			this.#storage,
			saleId,
			this.#locks,
			() => this.clock(),
			(work) => this.#afterCommit(saleId, work),
		);
		return this.#writer;
	}

	async #afterCommit(saleId: string, work: Work): Promise<void> {
		this.#broadcast(saleId, work);
		await this.#armAtMost(nextAlarm(work.touchedTimers()));
		// The d1 adapter queues the events now; the local one sends them once D1 has the rows.
		this.#storage.committed(work);
	}

	/** Pushes the commit to the sale's live sockets. The write already succeeded, so a failure is only logged. */
	#broadcast(saleId: string, work: Work): void {
		try {
			broadcastCommit(this.#live, work);
		} catch (error) {
			this.ctx.waitUntil(
				run(
					this.env,
					"engine.live.broadcast",
					Effect.logWarning("live broadcast failed", error).pipe(Effect.annotateLogs({ sale_id: saleId })),
				),
			);
		}
	}

	/** Moves the alarm earlier when a write created an earlier timer. A spurious early alarm is harmless. */
	async #armAtMost(at: Millis | null): Promise<void> {
		if (at === null) return;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || at < current) await this.ctx.storage.setAlarm(at);
	}

	/** Queues a sale's events for the notifications consumer (WS-K); throws if the queue refused. */
	async #sendEvents(saleId: string, events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
		await this.env.NOTIFICATIONS.send({ kind: "sale_events", sale_id: saleId, events });
	}

	/**
	 * Hands events to the notifications queue (WS-K consumes them), fire-and-forget: a
	 * command doesn't wait for the queue.
	 */
	#publish(saleId: string, events: ReadonlyArray<Record<string, unknown>>): void {
		const notifications = this.env.NOTIFICATIONS;
		const send = Effect.gen(function* () {
			const span = yield* Effect.currentSpan.pipe(Effect.orElseSucceed(() => undefined));
			const traceparent = span
				? formatTraceparent({ traceId: span.traceId, spanId: span.spanId, sampled: true })
				: undefined;
			yield* Effect.tryPromise(() =>
				notifications.send({
					kind: "sale_events",
					sale_id: saleId,
					events,
					...(traceparent ? { traceparent } : {}),
				}),
			);
		}).pipe(
			Effect.tapCause((cause) => Effect.logWarning("sale events not queued", cause)),
			Effect.orElseSucceed(() => undefined),
			Effect.annotateLogs({ sale_id: saleId, events: events.length }),
		);
		this.ctx.waitUntil(run(this.env, "engine.sale.publish_events", send));
	}

	async #processTimers(saleId: string): Promise<SweepReport> {
		const writer = await this.#writerFor(saleId);
		const due: Timer[] = dueTimers(await loadTimers(this.#storage, saleId, this.clock()), this.clock());
		for (const timer of due) await writer.runTimer(timer);
		// Writes still waiting for D1 (after a failed flush) go out with the alarm.
		await this.#storage.settle();
		const now = this.clock();
		let next = nextAlarm(await loadTimers(this.#storage, saleId, now));
		// Something still due failed to run (e.g. a write conflict): retry soon, not in a loop.
		if (next !== null && next <= now) next = now + RETRY_DELAY;
		const retry = this.#storage.retryAt(now);
		if (retry !== null && (next === null || retry < next)) next = Math.max(retry, now + 1_000);
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(next);
		return { processed: due.length, nextAlarm: next };
	}
}
