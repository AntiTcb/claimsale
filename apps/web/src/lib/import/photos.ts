import { unzip, type UnzipFileInfo } from "fflate";
import {
	PhotoError,
	preparePhoto,
	uploadPhoto,
	type PreparedPhoto,
	type UploadedPhoto,
} from "#lib/images/resize.ts";

/**
 * Import photos (PLAN §3c.1, D63): a ZIP unpacked in the browser with fflate. Rows
 * name their photos by file name; each one goes through the same resize, re-encode
 * and EXIF strip as a photo picked by hand, then the normal upload endpoint.
 */

/** PLAN §3c.1: at most 200 MB of photos per import. */
export const MAX_ZIP_BYTES = 200 * 1024 * 1024;

const IMAGE_TYPES: Readonly<Record<string, string>> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	heic: "image/heic",
	heif: "image/heif",
	gif: "image/gif",
};

const extension = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** Lowercase, forward slashes, no leading "./" or "/". */
const normalize = (path: string) =>
	path
		.trim()
		.replaceAll("\\", "/")
		.replace(/^(\.\/|\/)+/, "")
		.toLowerCase();

/** The photos in a ZIP, by normalized path and by bare file name. */
export interface PhotoZip {
	readonly count: number;
	find(name: string): Blob | undefined;
}

const isPhotoEntry = (file: Pick<UnzipFileInfo, "name">) =>
	!file.name.endsWith("/") &&
	!file.name.startsWith("__MACOSX/") &&
	!basename(file.name).startsWith(".") &&
	IMAGE_TYPES[extension(file.name)] !== undefined;

export class PhotoZipError extends Error {
	override readonly name = "PhotoZipError";
}

/** Unpacks the image files of a ZIP (other files are ignored). */
export async function readPhotoZip(data: Uint8Array): Promise<PhotoZip> {
	if (data.byteLength > MAX_ZIP_BYTES) throw new PhotoZipError("Photo ZIPs can be at most 200 MB.");
	const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
		unzip(data, { filter: isPhotoEntry }, (error, result) =>
			error ? reject(new PhotoZipError("That ZIP file couldn't be opened.")) : resolve(result),
		);
	});
	const byPath = new Map<string, Blob>();
	const byName = new Map<string, Blob>();
	for (const [path, bytes] of Object.entries(files)) {
		const blob = new Blob([bytes.slice()], {
			type: IMAGE_TYPES[extension(path)] ?? "application/octet-stream",
		});
		byPath.set(normalize(path), blob);
		// The first photo with a given name wins when folders repeat it.
		if (!byName.has(normalize(basename(path)))) byName.set(normalize(basename(path)), blob);
	}
	return {
		count: byPath.size,
		find: (name) => byPath.get(normalize(name)) ?? byName.get(normalize(basename(name))),
	};
}

export interface PhotoUploader {
	readonly prepare: (file: Blob) => Promise<PreparedPhoto>;
	readonly upload: (saleId: string, itemId: string, photo: PreparedPhoto) => Promise<UploadedPhoto>;
}

export const defaultUploader: PhotoUploader = { prepare: preparePhoto, upload: uploadPhoto };

/** Which of a row's photo names are missing from the ZIP. */
export function missingPhotos(names: readonly string[], zip: PhotoZip | null): string[] {
	return names.filter((name) => zip?.find(name) === undefined);
}

/**
 * Uploads a row's photos to its item, in the row's order, one at a time.
 *
 * @spec IO-import-photos — every photo goes through `preparePhoto` (resize, re-encode,
 * EXIF/GPS dropped) and the normal upload endpoint, which sanitizes it again; there
 * is no path that fetches a URL (core rejects URL-like photo names in the row).
 */
export async function uploadRowPhotos(input: {
	readonly saleId: string;
	readonly itemId: string;
	readonly names: readonly string[];
	readonly zip: PhotoZip | null;
	readonly uploader?: PhotoUploader;
}): Promise<{ readonly uploaded: number; readonly problems: readonly string[] }> {
	const uploader = input.uploader ?? defaultUploader;
	const problems: string[] = [];
	let uploaded = 0;
	for (const name of input.names) {
		const blob = input.zip?.find(name);
		if (blob === undefined) {
			problems.push(`${name}: not in the ZIP`);
			continue;
		}
		try {
			// One at a time on purpose, like the dropzone: phone connections.
			// oxlint-disable-next-line no-await-in-loop
			await uploader.upload(input.saleId, input.itemId, await uploader.prepare(blob));
			uploaded++;
		} catch (error) {
			problems.push(`${name}: ${error instanceof PhotoError ? error.message : "the upload failed"}`);
		}
	}
	return { uploaded, problems };
}
