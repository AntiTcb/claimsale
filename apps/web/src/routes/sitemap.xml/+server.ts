import { enabledGames } from "@claimsale/core";
import { db } from "#lib/server/context.ts";
import { sitemapSales } from "#lib/server/discovery.ts";
import type { RequestHandler } from "./$types";

const escape = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
	);

/**
 * The sitemap: the landing and browse pages, each game page and every public sale that
 * is scheduled or live (DISC-public-only; unlisted and private sales are never listed).
 */
export const GET: RequestHandler = async ({ url }) => {
	const origin = url.origin;
	const urls: Array<{ loc: string; lastmod?: number }> = [
		{ loc: `${origin}/` },
		{ loc: `${origin}/browse` },
		...enabledGames().map((g) => ({ loc: `${origin}/g/${g.slug}` })),
		...(await sitemapSales(db())).map((s) => ({ loc: `${origin}/s/${s.slug}`, lastmod: s.updatedAt })),
	];
	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
	.map(
		(u) =>
			`<url><loc>${escape(u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ""}</url>`,
	)
	.join("\n")}
</urlset>
`;
	return new Response(body, {
		headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=900" },
	});
};
