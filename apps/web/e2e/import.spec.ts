import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { expect, test } from "./fixtures.ts";
import { photo, signedUpSeller, startSale } from "./sell-helpers.ts";

// Item import (PLAN §3c.1, WS-G): a seller uploads a CSV and a ZIP of photos, maps and
// previews it, imports, downloads the results and finds the items with their photos.

test.describe("item import", () => {
	test("a seller imports a CSV with a photo ZIP, previews it and downloads the results", async ({
		page,
		expectAccessible,
	}) => {
		await signedUpSeller(page);
		await startSale(page, `Import test ${Date.now().toString(36)}`);
		await page.getByRole("link", { name: "Import", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Import items" })).toBeVisible();
		await page.waitForLoadState("networkidle");
		await expectAccessible();

		const csv = [
			"sku,game,kind,name,condition,price,photos",
			"BEWD-1,yugioh,single,Blue-Eyes White Dragon,NM,40,photos/bewd.png",
			"DM-1,yugioh,single,Dark Magician,LP,12.50,dm.png",
			"BAD-1,yugioh,single,Kuriboh,Mint-ish,1,",
		].join("\r\n");
		const blue = await photo(page, "#2255cc");
		const purple = await photo(page, "#8822aa");
		const zip = zipSync({
			"photos/bewd.png": new Uint8Array(blue.buffer),
			"dm.png": new Uint8Array(purple.buffer),
		});

		await page.getByLabel("Spreadsheet (CSV or .xlsx)").setInputFiles({
			name: "my-cards.csv",
			mimeType: "text/csv",
			buffer: Buffer.from(csv),
		});
		await page.getByLabel(/^Photos \(optional ZIP/).setInputFiles({
			name: "photos.zip",
			mimeType: "application/zip",
			buffer: Buffer.from(zip),
		});
		await page.getByRole("button", { name: "Read file" }).click();
		await expect(page.getByText("my-cards.csv: 3 rows, 2 photos in the ZIP.")).toBeVisible();
		// Our own column names map themselves.
		await expect(page.getByRole("combobox", { name: "Import column price as" })).toHaveValue("price");
		await page.getByRole("button", { name: "Preview import" }).click();

		await expect(page.getByTestId("import-summary")).toContainText("2 of 3 rows ready: 2 new");
		await expect(page.getByTestId("import-row")).toHaveCount(3);
		await expect(page.getByTestId("import-row").nth(2)).toContainText("condition: Condition must be one of");
		await page.getByRole("button", { name: "Import 2 rows" }).click();

		await expect(page.getByTestId("import-done")).toContainText(
			"Done: 2 created, 0 updated, 0 unchanged, 1 with errors.",
			{ timeout: 30_000 },
		);
		const download = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download results (CSV)" }).click();
		const results = await readFile(await (await download).path(), "utf8");
		expect(results).toContain("sku,game,kind,name,condition,price,photos,result,message");
		expect(results).toContain("BEWD-1,yugioh,single,Blue-Eyes White Dragon,NM,40,photos/bewd.png,created,");
		expect(results).toContain(
			'BAD-1,yugioh,single,Kuriboh,Mint-ish,1,,error,"condition: Condition must be one of',
		);

		await page.getByRole("link", { name: "Go to items" }).click();
		await expect(page.getByTestId("item-row")).toHaveCount(2);
		const img = page.getByRole("img", { name: "Photo 1 of Dark Magician" });
		await img.scrollIntoViewIfNeeded();
		await expect
			.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
			.toBe(2000);
		await expect(page.getByRole("img", { name: "Photo 1 of Blue-Eyes White Dragon" })).toBeVisible();
	});
});
