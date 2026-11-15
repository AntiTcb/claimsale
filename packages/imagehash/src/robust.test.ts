/**
 * IMG-hash-robust: the edits a re-uploader is likely to make keep a photo close to the
 * original on both hashes, and unrelated images stay apart. Images are synthetic (seeded
 * scenes and procedurally drawn cards); the fixture photos in ./fixtures are drawn the
 * same way (scripts/generate-fixtures.ts).
 *
 * Perceptual hashes are not exact under lossy edits: a few bits sit on near-ties and can
 * flip. So the random property tests assert what holds for every input (an edited copy is
 * never approved: ≤ 12 on both hashes), and a fixed, seeded corpus asserts the rate at
 * which edited copies are rejected outright (≤ 6). Measured on 300 images per edit:
 * 97–100 % rejected, 100 % at least held for review, worst case 9.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import type { Decoder } from "./decode.ts";
import { decidePhoto, REVIEW_MAX_DISTANCE } from "./decision.ts";
import type { RgbaImage } from "./grid.ts";
import { hashImage, matchDistance, type MatchDistance } from "./image.ts";
import { encode, nodeDecoder } from "./testing/node-codecs.ts";
import {
	adjust,
	applyEdit,
	cardPhoto,
	type Edit,
	resizeBilinear,
	rng,
	syntheticImage,
} from "./testing/synthetic.ts";

let decode: Decoder;
beforeAll(async () => {
	decode = await nodeDecoder();
});

/** Scene parameters; the image is drawn inside the property so counterexamples stay readable. */
const sceneArb = fc.record({
	seed: fc.nat(),
	width: fc.integer({ min: 120, max: 320 }),
	height: fc.integer({ min: 120, max: 320 }),
});
type Scene = { seed: number; width: number; height: number };
const draw = ({ seed, width, height }: Scene) => syntheticImage(seed, width, height);
const editArb = fc.constantFrom<Edit>("mirror", "r90", "r180", "r270");
const RUNS = { numRuns: 30 };

/** Distance from an edited upload (all its variants) to the original's stored hashes. */
function distance(original: RgbaImage, upload: RgbaImage): MatchDistance {
	return matchDistance(hashImage(upload), hashImage(original).orig);
}

function resize(img: RgbaImage, scale: number, aspect: number): RgbaImage {
	return resizeBilinear(
		img,
		Math.max(8, Math.round(img.width * scale * aspect)),
		Math.max(8, Math.round(img.height * scale)),
	);
}

type Transform = (img: RgbaImage, r: () => number) => Promise<RgbaImage>;

/** The edits, each drawing its parameters from `r` (a seeded generator). */
const transforms: Record<string, Transform> = {
	"resize 0.4–1.6×, aspect ±10 %": async (img, r) => resize(img, 0.4 + r() * 1.2, 0.9 + r() * 0.2),
	"JPEG quality 50–95": async (img, r) => decode(await encode(img, "jpeg", 50 + Math.floor(r() * 46))),
	"WebP quality 60–95": async (img, r) => decode(await encode(img, "webp", 60 + Math.floor(r() * 36))),
	"brightness ±20, contrast 0.85–1.15": async (img, r) =>
		adjust(img, Math.round(r() * 40 - 20), 0.85 + r() * 0.3),
	"mirror/rotate + resize 0.5–1.5× + JPEG 60–90": async (img, r) => {
		const edit = (["mirror", "r90", "r180", "r270"] as const)[Math.floor(r() * 4)]!;
		return decode(
			await encode(resize(applyEdit(img, edit), 0.5 + r(), 1), "jpeg", 60 + Math.floor(r() * 31)),
		);
	},
};

describe("[IMG-hash-robust] edited copies are caught", () => {
	it("[IMG-hash-robust] mirror and 90° rotations match exactly", () => {
		fc.assert(
			fc.property(sceneArb, editArb, (scene, edit) => {
				const img = draw(scene);
				expect(distance(img, applyEdit(img, edit))).toEqual({ dhash: 0, phash: 0 });
			}),
			RUNS,
		);
	});

	for (const [name, transform] of Object.entries(transforms)) {
		it(`[IMG-hash-robust] ${name}: never approved`, async () => {
			await fc.assert(
				fc.asyncProperty(sceneArb, fc.nat(), async (scene, paramSeed) => {
					const img = draw(scene);
					const d = distance(img, await transform(img, rng(paramSeed)));
					expect(Math.max(d.dhash, d.phash)).toBeLessThanOrEqual(REVIEW_MAX_DISTANCE);
					expect(decidePhoto([d])).not.toBe("approved");
				}),
				RUNS,
			);
		});
	}

	it("[IMG-hash-robust] edited copies are rejected outright at least 95 % of the time (seeded corpus)", async () => {
		const results: Record<string, number> = {};
		const corpus = 60;
		for (const [name, transform] of Object.entries(transforms)) {
			let rejected = 0;
			for (let i = 0; i < corpus; i++) {
				const r = rng(1000 + i);
				const img =
					i % 3 === 0
						? cardPhoto(i, 180, 240)
						: syntheticImage(i * 7919 + 1, 120 + Math.floor(r() * 200), 120 + Math.floor(r() * 200));
				if (decidePhoto([distance(img, await transform(img, r))]) === "rejected") rejected++;
			}
			results[name] = rejected / corpus;
		}
		expect(Object.entries(results).filter(([, rate]) => rate < 0.95)).toEqual([]);
	});
});

describe("[IMG-hash-robust] unrelated images stay apart", () => {
	it("[IMG-hash-robust] different scenes are approved (beyond the review distance)", () => {
		fc.assert(
			fc.property(sceneArb, sceneArb, (a, b) => {
				fc.pre(a.seed !== b.seed);
				expect(decidePhoto([distance(draw(a), draw(b))])).toBe("approved");
			}),
			{ numRuns: 60 },
		);
	});

	it("[IMG-hash-robust] different cards in the same layout are never auto-rejected", () => {
		fc.assert(
			fc.property(fc.nat(), fc.nat(), (s1, s2) => {
				fc.pre(s1 !== s2);
				expect(decidePhoto([distance(cardPhoto(s1, 120, 160), cardPhoto(s2, 120, 160))])).not.toBe(
					"rejected",
				);
			}),
			{ numRuns: 40 },
		);
	});
});

async function fixture(name: string): Promise<RgbaImage> {
	return decode(new Uint8Array(await readFile(join(import.meta.dirname, "fixtures", name))));
}

describe("[IMG-hash-robust] fixture photos", () => {
	it("[IMG-hash-robust] re-saved, mirrored or rotated, downsized copies of a photo are rejected", async () => {
		const original = await fixture("card-a.png");
		for (const edit of ["mirror", "r90", "r270"] as const) {
			const copy = await decode(await encode(resize(applyEdit(original, edit), 0.6, 1), "jpeg", 70));
			expect(decidePhoto([distance(original, copy)])).toBe("rejected");
		}
		expect(decidePhoto([distance(original, await fixture("card-a.webp"))])).toBe("rejected");
	});

	it("[IMG-hash-robust] a different card photo is not rejected", async () => {
		const d = distance(await fixture("card-a.jpg"), await fixture("card-b.jpg"));
		expect(decidePhoto([d])).not.toBe("rejected");
	});
});
