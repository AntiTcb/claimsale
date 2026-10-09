// Compile-time only: fails `pnpm typecheck` if EngineEnv drifts from wrangler.jsonc.
import type { EngineEnv } from "./env.ts";

type Assert<T extends true> = T;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type EngineEnvMatchesWrangler = Assert<Mutual<EngineEnv, Readonly<Env>>>;
