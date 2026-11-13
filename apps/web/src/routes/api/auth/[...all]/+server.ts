import { auth } from "#lib/server/context.ts";
import type { RequestHandler } from "./$types";

/** Better Auth's endpoints: email verification and OAuth callbacks land here. */
const handler: RequestHandler = ({ request, url }) => auth(url.origin).handler(request);

export const GET = handler;
export const POST = handler;
