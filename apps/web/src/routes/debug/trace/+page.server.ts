import { error } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { isProbeEnabled } from "#lib/server/trace-probe.ts";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
	if (!isProbeEnabled(env.APP_ENV)) error(404, "Not found");
	return { appEnv: env.APP_ENV, version: env.VERSION };
};
