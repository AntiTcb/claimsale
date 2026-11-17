import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { PhotoError, type PreparedPhoto } from "#lib/images/resize.ts";
import { parseSpreadsheet } from "./parse.ts";
import { missingPhotos, readPhotoZip, uploadRowPhotos, type PhotoUploader } from "./photos.ts";

// Runs in a real browser: read-excel-file's browser build and fflate's worker-based unzip.

const cell = (value: string | number, ref: string) =>
	typeof value === "number"
		? `<c r="${ref}"><v>${value}</v></c>`
		: `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;

/** A minimal .xlsx: one sheet with inline strings and a number. */
function xlsx(rows: (string | number)[][]): File {
	const sheet = rows
		.map(
			(row, r) =>
				`<row r="${r + 1}">${row.map((v, c) => cell(v, `${String.fromCharCode(65 + c)}${r + 1}`)).join("")}</row>`,
		)
		.join("");
	const files = {
		"[Content_Types].xml": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		),
		"_rels/.rels": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
		),
		"xl/workbook.xml": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>',
		),
		"xl/_rels/workbook.xml.rels": strToU8(
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
		),
		"xl/worksheets/sheet1.xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
		),
	};
	return new File([zipSync(files).slice()], "items.xlsx", {
		type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	});
}

describe("import files", () => {
	it("reads CSV (Windows-1252, ; delimiters) and XLSX into a table of strings", async () => {
		// "Pokémon" in Windows-1252: é is 0xE9.
		const bytes = new Uint8Array([
			...new TextEncoder().encode("game;name\r\nPok"),
			0xe9,
			...new TextEncoder().encode("mon;Pikachu\r\n"),
		]);
		const csv = await parseSpreadsheet(new File([bytes], "items.csv", { type: "text/csv" }));
		expect(csv).toEqual({
			format: "csv",
			table: [
				["game", "name"],
				["Pokémon", "Pikachu"],
			],
		});

		const sheet = await parseSpreadsheet(
			xlsx([
				["name", "price"],
				["Sol Ring", 1.5],
			]),
		);
		expect(sheet).toEqual({
			format: "xlsx",
			table: [
				["name", "price"],
				["Sol Ring", "1.5"],
			],
		});

		await expect(parseSpreadsheet(new File(["x"], "photo.jpg"))).rejects.toThrow("Choose a CSV or Excel");
		await expect(parseSpreadsheet(new File(["not a zip"], "broken.xlsx"))).rejects.toThrow(
			"couldn't be read",
		);
	});

	it("[IO-import-photos] unzips photos and uploads each through resize + the normal upload", async () => {
		const zip = await readPhotoZip(
			zipSync({
				"photos/Front.JPG": new Uint8Array([1]),
				"back.webp": new Uint8Array([2]),
				"__MACOSX/photos/._Front.JPG": new Uint8Array([3]),
				"notes.txt": strToU8("hi"),
			}),
		);
		expect(zip.count).toBe(2);
		expect(zip.find("front.jpg")?.type).toBe("image/jpeg");
		expect(zip.find("photos/front.jpg")).toBeDefined();
		expect(zip.find("notes.txt")).toBeUndefined();
		expect(missingPhotos(["front.jpg", "side.jpg"], zip)).toEqual(["side.jpg"]);
		expect(missingPhotos(["front.jpg"], null)).toEqual(["front.jpg"]);

		const prepared: PreparedPhoto = { blob: new Blob(["x"], { type: "image/webp" }), width: 1, height: 1 };
		const prepare = vi.fn<(file: Blob) => Promise<PreparedPhoto>>(async () => prepared);
		const upload = vi.fn<PhotoUploader["upload"]>(async (_sale, _item, photo) => {
			if (photo !== prepared) throw new Error("not prepared");
			if (upload.mock.calls.length === 2) throw new PhotoError("This item already has 4 photos.");
			return { id: "img", url: "/api/images/img" };
		});
		const uploader: PhotoUploader = { prepare, upload };
		const result = await uploadRowPhotos({
			saleId: "s1",
			itemId: "i1",
			names: ["Front.jpg", "back.webp", "missing.png"],
			zip,
			uploader,
		});
		// Every photo went through prepare (resize + re-encode, which drops EXIF) before upload.
		expect(prepare.mock.calls.map(([blob]) => blob.type)).toEqual(["image/jpeg", "image/webp"]);
		expect(upload).toHaveBeenCalledWith("s1", "i1", prepared);
		expect(result).toEqual({
			uploaded: 1,
			problems: ["back.webp: This item already has 4 photos.", "missing.png: not in the ZIP"],
		});
		await expect(readPhotoZip(new Uint8Array([1, 2, 3]))).rejects.toThrow("couldn't be opened");
	});
});
