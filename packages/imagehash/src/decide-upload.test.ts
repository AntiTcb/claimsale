/**
 * The full upload verdict: other sellers' matches (reject / review) plus own reuse and
 * timestamp reuse. The engine's verify job (WS-F2) feeds it the band lookup's matches.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decidePhoto, decideUpload, type PhotoPlace, type StoredMatch } from "./decision.ts";

const upload: PhotoPlace = { sellerId: "me", saleId: "sale-1", itemId: "item-1" };
const timestamp: PhotoPlace = { ...upload, itemId: null };

function match(over: Partial<StoredMatch> & { d?: number; p?: number }): StoredMatch {
	const { d = 0, p = 0, ...rest } = over;
	return {
		imageId: "img-x",
		sellerId: "other",
		saleId: "sale-9",
		itemId: "item-9",
		inUse: true,
		distance: { dhash: d, phash: p },
		...rest,
	};
}

describe("decideUpload", () => {
	it("[IMG-dup-reject] another seller's image within 6 rejects, naming the closest match for admins", () => {
		const v = decideUpload(upload, [
			match({ imageId: "far", d: 6, p: 5 }),
			match({ imageId: "near", d: 1, p: 2 }),
			match({ imageId: "review", d: 9, p: 9 }),
		]);
		expect(v).toEqual({ decision: "rejected", reason: "duplicate", match: { imageId: "near", distance: 2 } });
	});

	it("[IMG-dup-reject] another seller's deleted image still counts (past or present)", () => {
		expect(decideUpload(upload, [match({ inUse: false })]).decision).toBe("rejected");
	});

	it("[IMG-dup-review] another seller's image at 7–12 on both hashes holds the photo for review", () => {
		expect(decideUpload(upload, [match({ imageId: "r", d: 7, p: 12 })])).toEqual({
			decision: "review",
			reason: "possible_duplicate",
			match: { imageId: "r", distance: 12 },
		});
		expect(decideUpload(upload, [match({ d: 7, p: 13 })]).decision).toBe("approved");
	});

	it("[IMG-own-reuse] reusing your photo for a different item of the same sale is rejected", () => {
		const v = decideUpload(upload, [
			match({ imageId: "mine", sellerId: "me", saleId: "sale-1", itemId: "item-2", d: 0, p: 0 }),
		]);
		expect(v).toEqual({ decision: "rejected", reason: "own_reuse", match: { imageId: "mine", distance: 0 } });
	});

	it("[IMG-own-reuse] your photo on the same item, in another sale (relisting), or deleted is allowed", () => {
		const own = (o: Partial<StoredMatch>) => match({ sellerId: "me", ...o });
		expect(decideUpload(upload, [own({ saleId: "sale-1", itemId: "item-1" })]).decision).toBe("approved");
		expect(decideUpload(upload, [own({ saleId: "sale-0", itemId: "item-0" })]).decision).toBe("approved");
		expect(decideUpload(upload, [own({ saleId: "sale-1", itemId: "item-2", inUse: false })]).decision).toBe(
			"approved",
		);
		// The sale's own timestamp photo isn't another item.
		expect(decideUpload(upload, [own({ saleId: "sale-1", itemId: null })]).decision).toBe("approved");
		// Own matches never go to review.
		expect(decideUpload(upload, [own({ saleId: "sale-1", itemId: "item-2", d: 9, p: 9 })]).decision).toBe(
			"approved",
		);
	});

	it("[IMG-timestamp-required] a timestamp photo already used in another sale is rejected, even your own", () => {
		const v = decideUpload(timestamp, [
			match({ imageId: "old", sellerId: "me", saleId: "sale-0", itemId: null }),
		]);
		expect(v).toEqual({
			decision: "rejected",
			reason: "timestamp_reuse",
			match: { imageId: "old", distance: 0 },
		});
		expect(
			decideUpload(timestamp, [match({ sellerId: "me", saleId: "sale-0", itemId: null, inUse: false })])
				.decision,
		).toBe("rejected");
		// Re-uploading it within the same sale is fine.
		expect(
			decideUpload(timestamp, [match({ sellerId: "me", saleId: "sale-1", itemId: null })]).decision,
		).toBe("approved");
	});

	it("[IMG-dup-reject] another seller's match outranks own reuse", () => {
		const v = decideUpload(upload, [
			match({ imageId: "mine", sellerId: "me", saleId: "sale-1", itemId: "item-2" }),
			match({ imageId: "theirs", d: 3, p: 3 }),
		]);
		expect(v.reason).toBe("duplicate");
	});

	it("[IMG-dup-reject] [IMG-dup-review] property: other sellers' matches decide exactly as decidePhoto", () => {
		const distance = fc.integer({ min: 0, max: 64 });
		const arb = fc.array(fc.record({ d: distance, p: distance }), { maxLength: 6 });
		fc.assert(
			fc.property(arb, (ds) => {
				const matches = ds.map((x, i) => match({ imageId: `m${i}`, d: x.d, p: x.p }));
				const v = decideUpload(upload, matches);
				expect(v.decision).toBe(decidePhoto(matches.map((m) => m.distance)));
				expect(v.match === null).toBe(v.decision === "approved");
			}),
		);
	});
});
