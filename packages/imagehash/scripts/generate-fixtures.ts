/**
 * Regenerates the committed fixture photos in src/fixtures/. They are procedurally drawn
 * (no third-party images): `card-a` in all three formats from the same pixels, and
 * `card-b`, a different card in the same layout.
 *
 * Usage: node packages/imagehash/scripts/generate-fixtures.ts
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encode } from "../src/testing/node-codecs.ts";
import { cardPhoto } from "../src/testing/synthetic.ts";

const dir = join(import.meta.dirname, "..", "src", "fixtures");
const cardA = cardPhoto(1, 240, 320);
const cardB = cardPhoto(2, 240, 320);

const files: [string, Uint8Array][] = [
	["card-a.jpg", await encode(cardA, "jpeg", 88)],
	["card-a.png", await encode(cardA, "png")],
	["card-a.webp", await encode(cardA, "webp", 88)],
	["card-b.jpg", await encode(cardB, "jpeg", 88)],
];
for (const [name, bytes] of files) {
	await writeFile(join(dir, name), bytes);
	console.log(`${name}: ${bytes.length} bytes`);
}
