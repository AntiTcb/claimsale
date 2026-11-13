import {
	createExecutionContext,
	createMessageBatch,
	createScheduledController,
	getQueueResult,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { handleQueue, handleScheduled } from "../src/handlers.ts";
import { CloudflareMailer, MailError, Mailer, type OutgoingMail } from "../src/mailer.ts";
import { optionalSecret, run, runForRpc } from "../src/runtime.ts";
import { isProbeEnabled } from "../src/trace-probe.ts";

describe("engine health (RPC)", () => {
	it("reports ok when D1 is migrated and the Durable Object answers", async () => {
		const report = await exports.default.health();
		expect(report).toEqual({
			status: "ok",
			service: "engine",
			env: "test",
			version: "dev",
			checks: { d1: "ok", durableObject: "ok" },
		});
	});

	it("reports degraded, without throwing, when D1 is unusable", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await env.DB.exec("ALTER TABLE app_meta RENAME TO app_meta_hidden");
		try {
			const report = await exports.default.health();
			expect(report.status).toBe("degraded");
			expect(report.checks).toEqual({ d1: "error", durableObject: "ok" });
		} finally {
			await env.DB.exec("ALTER TABLE app_meta_hidden RENAME TO app_meta");
			error.mockRestore();
		}
	});
});

describe("engine HTTP", () => {
	it("has no public routes", async () => {
		const res = await exports.default.fetch("https://engine.internal/anything");
		expect(res.status).toBe(404);
	});
});

describe("SaleEngine Durable Object", () => {
	it("answers ping over RPC", async () => {
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("sale_1"));
		expect(await stub.ping()).toBe("pong");
	});

	it("runs a scheduled alarm and logs it as JSON", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("sale_2"));
		await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
		expect(lines).toContainEqual(
			expect.objectContaining({ msg: "sale engine alarm fired", service: "engine", level: "info" }),
		);
		log.mockRestore();
	});
});

function fakeMailer(fail = false) {
	const sent: OutgoingMail[] = [];
	const layer = Layer.succeed(Mailer, {
		send: (mail) =>
			fail
				? Effect.fail(new MailError({ cause: new Error("sender domain not onboarded") }))
				: Effect.sync(() => {
						sent.push(mail);
						return { messageId: `m-${sent.length}` };
					}),
	});
	return { sent, layer };
}

async function consume(bodies: unknown[], probeRecipient: string | undefined, mailer = fakeMailer()) {
	const batch = createMessageBatch(
		"claimsale-notifications-local",
		bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
	);
	const ctx = createExecutionContext();
	await Effect.runPromise(handleQueue(batch, { probeRecipient }).pipe(Effect.provide(mailer.layer)));
	return { result: await getQueueResult(batch, ctx), sent: mailer.sent };
}

describe("queue consumer", () => {
	const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

	it("emails the trace probe recipient and acknowledges the message", async () => {
		const { result, sent } = await consume(
			[{ kind: "trace_probe", probe_id: "p1", traceparent }],
			"owner@example.com",
		);
		expect(sent).toEqual([
			expect.objectContaining({ to: "owner@example.com", subject: "ClaimSale trace probe p1" }),
		]);
		expect(result.explicitAcks).toEqual(["m0"]);
		expect(result.retryMessages).toEqual([]);
	});

	it("acknowledges a trace probe without sending when no recipient is set", async () => {
		const { result, sent } = await consume([{ kind: "trace_probe", probe_id: "p2" }], undefined);
		expect(sent).toEqual([]);
		expect(result.explicitAcks).toEqual(["m0"]);
	});

	it("retries the message when the email can't be sent", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { result } = await consume(
			[{ kind: "trace_probe", probe_id: "p3" }],
			"owner@example.com",
			fakeMailer(true),
		);
		expect(result.retryMessages).toEqual([{ msgId: "m0" }]);
		expect(result.explicitAcks).toEqual([]);
		warn.mockRestore();
	});

	it("acknowledges and drops messages it doesn't understand", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { result } = await consume([{ kind: "test" }, "garbage"], undefined);
		expect(result.explicitAcks).toEqual(["m0", "m1"]);
		warn.mockRestore();
	});
});

describe("trace probe (T28 observability spike)", () => {
	it("crosses RPC, the Durable Object, D1 and the queue, and returns its trace", async () => {
		const outcome = await exports.default.traceProbe({});
		if (!outcome.ok) throw new Error(outcome.error.message);
		const result = outcome.value;
		expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(result.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(result.queued).toBe(true);
		expect(result.runtime).toEqual({ spanContext: expect.any(Boolean), withActiveSpan: expect.any(Boolean) });
	});

	it("returns a deliberate Durable Object defect to the caller as data", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const outcome = await exports.default.traceProbe({ fail: true });
		expect(outcome).toEqual({
			ok: false,
			error: { name: "Error", message: expect.stringMatching(/deliberate failure$/) },
		});
		error.mockRestore();
	});

	it("returns invalid input to the caller as data", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const outcome = await exports.default.traceProbe({ fail: "yes" } as never);
		expect(outcome).toMatchObject({ ok: false, error: { name: "SchemaError" } });
		error.mockRestore();
	});

	it("is disabled in production", () => {
		expect(isProbeEnabled({ APP_ENV: "production" })).toBe(false);
		expect(isProbeEnabled({ APP_ENV: "staging" })).toBe(true);
	});
});

describe("engine runtime", () => {
	it("reports a defect to Sentry with the root span's trace ID, and rejects", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const withDsn = { ...env, SENTRY_DSN: "https://pubkey@sentry.example/42" };
			let traceId = "";
			const program = Effect.currentSpan.pipe(
				Effect.tap((span) => Effect.sync(() => (traceId = span.traceId))),
				Effect.andThen(Effect.die(new Error("engine bug"))),
			);
			await expect(run(withDsn, "engine.test", program)).rejects.toThrow("engine bug");
			await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(url).toBe("https://sentry.example/api/42/envelope/");
			const event = JSON.parse((init!.body as string).trimEnd().split("\n")[2]!) as {
				tags: Record<string, string>;
			};
			expect(event.tags).toMatchObject({ service: "engine", trace_id: traceId });
		} finally {
			fetchSpy.mockRestore();
			error.mockRestore();
		}
	});

	it("runForRpc reports the defect once and returns it as data", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const withDsn = { ...env, SENTRY_DSN: "https://pubkey@sentry.example/42" };
			const outcome = await runForRpc(withDsn, "engine.test", Effect.die(new TypeError("bad state")));
			expect(outcome).toEqual({ ok: false, error: { name: "TypeError", message: "bad state" } });
			await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
			expect(await runForRpc(withDsn, "engine.test", Effect.fail("ItemSoldOut"))).toEqual({
				ok: false,
				error: { name: "Error", message: "ItemSoldOut" },
			});
			expect(await runForRpc(withDsn, "engine.test", Effect.succeed(1))).toEqual({ ok: true, value: 1 });
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchSpy.mockRestore();
			error.mockRestore();
		}
	});

	it("reads optional secrets, ignoring blanks", () => {
		expect(optionalSecret({ ...env, TRACE_PROBE_TO: " a@b.co " } as never, "TRACE_PROBE_TO")).toBe("a@b.co");
		expect(optionalSecret({ ...env, TRACE_PROBE_TO: " " } as never, "TRACE_PROBE_TO")).toBeUndefined();
		expect(optionalSecret(env, "TRACE_PROBE_TO")).toBeUndefined();
	});
});

describe("CloudflareMailer", () => {
	it("sends through the (simulated) Email Service binding", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const mailer = yield* Mailer;
				return yield* mailer.send({ to: "someone@example.com", subject: "hi", text: "hello" });
			}).pipe(Effect.provide(CloudflareMailer(env.EMAIL, env.MAIL_FROM))),
		);
		expect(result.messageId).toEqual(expect.any(String));
	});
});

describe("cron sweep", () => {
	it("runs without error", async () => {
		const controller = createScheduledController({ scheduledTime: new Date(), cron: "*/5 * * * *" });
		await expect(Effect.runPromise(handleScheduled(controller))).resolves.toBeUndefined();
	});
});

describe("D1 migrations (expand/contract)", () => {
	const authTables = ["users", "sessions", "auth_accounts", "verifications", "rate_limits", "email_outbox"];

	it("apply to an empty database: every auth table exists", async () => {
		const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
			name: string;
		}>();
		expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(["app_meta", ...authTables]));
	});

	it("apply on top of the previous schema without touching existing data", async () => {
		const [first, ...rest] = env.TEST_MIGRATIONS;
		expect(first?.name).toMatch(/^0000_/);
		const stub = env.SALE_ENGINE.get(env.SALE_ENGINE.idFromName("migration-check"));
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			for (const query of first!.queries) sql.exec(query);
			sql.exec("INSERT INTO app_meta (key, value, updated_at) VALUES ('seeded', 'yes', 1)");
			for (const migration of rest) for (const query of migration.queries) sql.exec(query);
			expect(sql.exec("SELECT value FROM app_meta WHERE key = 'seeded'").one()).toEqual({ value: "yes" });
			const tables = sql
				.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
				.toArray()
				.map((r) => r["name"]);
			expect(tables).toEqual(expect.arrayContaining(authTables));
		});
	});

	it("0001_auth only adds tables and indexes (expand step)", () => {
		const auth = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0001_"));
		const statements = auth!.queries.map((q) => q.replace(/^--.*$/gm, "").trim()).filter(Boolean);
		expect(statements.length).toBeGreaterThan(0);
		for (const statement of statements) expect(statement).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) /i);
	});
});
