import { env, tracing, waitUntil } from "cloudflare:workers";
import { makeWebRuntime } from "./observability.ts";

/** The web runtime, wired to `cloudflare:workers` (see observability.ts). */
export const { runExit, activeTraceIds, reportError } = makeWebRuntime({ env, tracing, waitUntil });
