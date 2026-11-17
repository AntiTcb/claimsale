/**
 * Browser-side photo preparation (PLAN §5 "Images"): decode the picked file
 * (honouring its EXIF orientation), scale it so the longest side is at most
 * 2000px, and re-encode it on a canvas. Re-encoding drops every metadata block,
 * including EXIF/GPS, and cuts the upload size. The server re-checks all of it.
 */

export const MAX_SIDE = 2000;
const QUALITY = 0.85;

export interface PreparedPhoto {
	readonly blob: Blob;
	readonly width: number;
	readonly height: number;
}

/** The size that fits `maxSide`, keeping the aspect ratio; never upscales. */
export function fitWithin(
	width: number,
	height: number,
	maxSide = MAX_SIDE,
): { width: number; height: number } {
	const scale = Math.min(1, maxSide / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

export async function preparePhoto(file: Blob, maxSide = MAX_SIDE): Promise<PreparedPhoto> {
	if (!file.type.startsWith("image/"))
		throw new PhotoError("Choose an image file (JPEG, PNG, WebP or HEIC).");
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		throw new PhotoError("This photo couldn't be read. Try a JPEG or PNG.");
	}
	const size = fitWithin(bitmap.width, bitmap.height, maxSide);
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");
	if (!context) throw new PhotoError("Your browser couldn't process this photo.");
	context.drawImage(bitmap, 0, 0, size.width, size.height);
	bitmap.close();
	// WebP where the browser can encode it (Safari can't, and returns PNG); JPEG otherwise.
	const webp = await encode(canvas, "image/webp");
	const blob = webp?.type === "image/webp" ? webp : await encode(canvas, "image/jpeg");
	if (!blob) throw new PhotoError("Your browser couldn't process this photo.");
	return { blob, ...size };
}

export class PhotoError extends Error {
	override readonly name = "PhotoError";
}

export interface UploadedPhoto {
	readonly id: string;
	readonly url: string;
}

/** Sends a prepared photo to the Worker, which stores it in R2 as `pending`. */
export function uploadPhoto(saleId: string, itemId: string, photo: PreparedPhoto): Promise<UploadedPhoto> {
	return send(new URLSearchParams({ sale: saleId, item: itemId }), photo);
}

/** The sale's timestamp photo (D66): the cards beside a note with the handle and date. */
export function uploadTimestampPhoto(saleId: string, photo: PreparedPhoto): Promise<UploadedPhoto> {
	return send(new URLSearchParams({ sale: saleId, kind: "timestamp" }), photo);
}

async function send(params: URLSearchParams, photo: PreparedPhoto): Promise<UploadedPhoto> {
	const response = await fetch(`/api/uploads?${params}`, {
		method: "POST",
		headers: { "content-type": photo.blob.type },
		body: photo.blob,
	});
	const body: unknown = await response.json().catch(() => null);
	const text = (key: string) => {
		const value: unknown = typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;
		return typeof value === "string" ? value : undefined;
	};
	const id = text("id");
	const url = text("url");
	if (!response.ok || !id || !url) throw new PhotoError(text("message") ?? "The upload failed. Try again.");
	return { id, url };
}

export async function deletePhoto(imageId: string): Promise<void> {
	const response = await fetch(`/api/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
	if (!response.ok) throw new PhotoError("The photo couldn't be removed. Try again.");
}
