import type { RequestHandler } from "./$types";

/** Crawlers may read public pages; account, seller and admin pages are off limits. */
export const GET: RequestHandler = ({ url }) =>
	new Response(
		[
			"User-agent: *",
			"Disallow: /sell",
			"Disallow: /me",
			"Disallow: /admin",
			"Disallow: /api",
			"Disallow: /search",
			"",
			`Sitemap: ${url.origin}/sitemap.xml`,
			"",
		].join("\n"),
		{ headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } },
	);
