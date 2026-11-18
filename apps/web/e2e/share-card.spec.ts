import { expect, test } from "./fixtures.ts";
import { publicSaleWithItem, signedUpSeller } from "./sell-helpers.ts";

// Share cards (WS-L2): a sale link posted in a Facebook group previews as an image of the
// sale. Crawlers fetch without cookies, so this checks what a signed-out visitor gets.

test.describe("share card", () => {
	test("a scheduled sale's page carries og tags whose image renders, cached per version", async ({
		page,
		browser,
	}) => {
		// Photo checks batch for a few seconds.
		test.slow();
		await signedUpSeller(page);
		const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		const title = `Share sale ${id}`;
		const salePath = await publicSaleWithItem(page, title, { title: `Mew ${id}`, price: "12.50" });

		const visitor = await browser.newContext();
		const anon = await visitor.newPage();
		await anon.goto(salePath);
		const meta = (property: string) => anon.locator(`meta[property="${property}"]`);
		await expect(meta("og:title")).toHaveAttribute("content", title);
		await expect(meta("og:description")).toHaveAttribute(
			"content",
			/^1 item from .+\. Upcoming\. Claim on ClaimSale\.$/,
		);
		await expect(meta("og:url")).toHaveAttribute("content", new RegExp(`${salePath}$`));
		await expect(anon.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
		const image = await meta("og:image").getAttribute("content");
		expect(image).toMatch(new RegExp(`/og/s/[^/]+\\.png\\?v=\\d+-[0-9a-z]+$`));

		// The versioned URL is cacheable for a day; the image is a PNG (rendered, then from R2).
		for (let i = 0; i < 2; i++) {
			const response = await anon.request.get(image!);
			expect(response.status()).toBe(200);
			expect(response.headers()["content-type"]).toBe("image/png");
			expect(response.headers()["cache-control"]).toBe("public, max-age=86400");
			expect([...(await response.body()).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
		}

		// A sale that doesn't exist has no image.
		expect((await anon.request.get(`/og/s/no-such-sale-${id}.png`)).status()).toBe(404);
		await visitor.close();
	});
});
