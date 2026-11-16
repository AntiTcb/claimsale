import { describe, expect, it } from "vitest";
import { fitWithin, preparePhoto, PhotoError } from "./resize.ts";

/** A real image file made on a canvas, so the browser can decode it. */
async function pngOf(width: number, height: number): Promise<File> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "#c33";
	context.fillRect(0, 0, width, height);
	const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
	return new File([blob], "photo.png", { type: "image/png" });
}

/** The first bytes of the encoded file, to check its format and that it carries no EXIF block. */
async function head(blob: Blob): Promise<string> {
	return new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));
}

describe("photo preparation (browser)", () => {
	it("fits the longest side within 2000px, keeping the ratio and never upscaling", () => {
		expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500 });
		expect(fitWithin(1500, 6000)).toEqual({ width: 500, height: 2000 });
		expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
	});

	it("re-encodes a large photo to at most 2000px as WebP or JPEG, with no EXIF", async () => {
		const result = await preparePhoto(await pngOf(3000, 1500));
		expect({ width: result.width, height: result.height }).toEqual({ width: 2000, height: 1000 });
		expect(["image/webp", "image/jpeg"]).toContain(result.blob.type);
		const bytes = await head(result.blob);
		expect(bytes).not.toContain("Exif");
		const bitmap = await createImageBitmap(result.blob);
		expect([bitmap.width, bitmap.height]).toEqual([2000, 1000]);
	});

	it("rejects files that aren't images, or can't be decoded", async () => {
		await expect(preparePhoto(new File(["hi"], "notes.txt", { type: "text/plain" }))).rejects.toBeInstanceOf(
			PhotoError,
		);
		await expect(preparePhoto(new File(["nope"], "broken.jpg", { type: "image/jpeg" }))).rejects.toThrow(
			"This photo couldn't be read",
		);
	});
});
