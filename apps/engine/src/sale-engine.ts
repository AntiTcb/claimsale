import { formatTraceparent } from "@claimsale/observability";
import { dueTimers, nextAlarm, type Millis, type Timer } from "@claimsale/core";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { EngineEnv } from "./env.ts";
import { LiveHub } from "./live/hub.ts";
import { broadcastCommit, connectLive, parseLivePath, VIEWER_HEADER } from "./live/sale-live.ts";
import { run, runForRpc, runtimeCapabilities, type RpcResult } from "./runtime.ts";
import { KeyedLocks } from "./sale/locks.ts";
import { loadTimers } from "./sale/timers.ts";
import type { Work } from "./sale/store.ts";
import { SaleWriter, type Outcome } from "./sale/writer.ts";
import { disabledProbe, isProbeEnabled, probeInDurableObject, type TraceProbeResult } from "./trace-probe.ts";

export type { ItemCommandResult, InvoiceView, Outcome, SaleView } from "./sale/writer.ts";

/** How long the alarm waits before retrying a timer that is still due after it ran. */
const RETRY_DELAY: Millis = 15_000;

/** The SaleWriter methods the engine exposes, by name. */
export type WriterMethod = {
	[K in keyof SaleWriter]: SaleWriter[K] extends (input: never) => Promise<Outcome<unknown>> ? K : never;
}[keyof SaleWriter];

export interface SweepReport {
	readonly processed: number;
	readonly nextAlarm: Millis | null;
}

/**
 * One instance per sale, addressed by `idFromName(saleId)` (STATE_MACHINES §9). It
 * serializes the sale's writes (per-item locks), owns the sale's single alarm (§7),
 * holds the sale page's live sockets (WS-H) and holds no state that D1 can't rebuild:
 * only the sale ID it serves.
 */
export class SaleEngine extends DurableObject<EngineEnv> {
	readonly #locks = new KeyedLocks();
	readonly #live: LiveHub;
	#saleId: string | undefined;
	#writer: SaleWriter | undefined;

	constructor(ctx: DurableObjectState, env: EngineEnv) {
		super(ctx, env);
		this.#live = new LiveHub(ctx);
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
			Effect.promise(() => connectLive(this.#live, this.env.DB, saleId, userId, this.clock())),
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
				return call.call(writer, input);
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
		this.#writer ??= new SaleWriter(
			this.env.DB,
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
		if (work.events.length > 0) this.#publish(saleId, work.events);
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

	/**
	 * Hands the committed events to the notifications queue (WS-K consumes them).
	 * Fire-and-forget after the commit: a claim doesn't wait for the queue.
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
		const due: Timer[] = dueTimers(await loadTimers(this.env.DB, saleId, this.clock()), this.clock());
		for (const timer of due) await writer.runTimer(timer);
		const now = this.clock();
		let next = nextAlarm(await loadTimers(this.env.DB, saleId, now));
		// Something still due failed to run (e.g. a write conflict): retry soon, not in a loop.
		if (next !== null && next <= now) next = now + RETRY_DELAY;
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(next);
		return { processed: due.length, nextAlarm: next };
	}
}
