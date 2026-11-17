import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	checkPublishPhotos,
	isRepeatOffender,
	isTimestamped,
	needsTimestampPhoto,
	PHOTO_STATUSES,
	REPEAT_OFFENDER_REJECTIONS,
	TIMESTAMP_EXEMPT_COMPLETED_SALES,
	type PhotoStatus,
	type PublishPhotoState,
} from "./photos.ts";

const veteran = TIMESTAMP_EXEMPT_COMPLETED_SALES;
const state = (
	items: PhotoStatus[][],
	timestamp: PhotoStatus | null = null,
	completedSales = veteran,
): PublishPhotoState => ({ items: items.map((photos) => ({ photos })), timestamp, completedSales });
const code = (s: PublishPhotoState) => {
	const result = checkPublishPhotos(s);
	return result.ok ? "ok" : result.error.code;
};

describe("publishing needs approved photos", () => {
	it("[IMG-required] every item with an approved photo passes", () => {
		expect(code(state([["approved"], ["pending", "approved"], ["rejected", "approved"]]))).toBe("ok");
	});

	it("[IMG-required] an item without photos, or with only rejected ones, blocks publishing", () => {
		expect(code(state([["approved"], []]))).toBe("missing_photos");
		expect(code(state([["approved"], ["rejected"]]))).toBe("missing_photos");
		expect(checkPublishPhotos(state([[]]))).toEqual({
			ok: false,
			error: { code: "missing_photos", message: "Add at least one photo to every item before publishing" },
		});
	});

	it("[IMG-required] a photo still being checked doesn't count yet", () => {
		expect(code(state([["approved"], ["pending"]]))).toBe("photos_pending");
	});

	it("[IMG-dup-review] a photo held for review blocks publishing until resolved", () => {
		expect(code(state([["review"]]))).toBe("photos_in_review");
		expect(code(state([["review", "approved"]]))).toBe("ok");
	});

	it("[IMG-required] property: publishing passes exactly when every item has an approved photo (veterans)", () => {
		const status = fc.constantFrom(...PHOTO_STATUSES);
		fc.assert(
			fc.property(fc.array(fc.array(status, { maxLength: 4 }), { maxLength: 6 }), (items) => {
				const allApproved = items.every((photos) => photos.includes("approved"));
				expect(checkPublishPhotos(state(items)).ok).toBe(allApproved);
			}),
		);
	});
});

describe("timestamp photos (D66)", () => {
	it("[IMG-timestamp-required] sellers with fewer than 5 completed sales need an approved timestamp photo", () => {
		expect(needsTimestampPhoto(4)).toBe(true);
		expect(needsTimestampPhoto(5)).toBe(false);
		expect(code(state([["approved"]], null, 4))).toBe("timestamp_required");
		expect(code(state([["approved"]], "rejected", 0))).toBe("timestamp_required");
		expect(code(state([["approved"]], "pending", 0))).toBe("timestamp_pending");
		expect(code(state([["approved"]], "review", 0))).toBe("timestamp_in_review");
		expect(code(state([["approved"]], "approved", 0))).toBe("ok");
	});

	it("[IMG-timestamp-required] it's optional from 5 completed sales on", () => {
		expect(code(state([["approved"]], null, 5))).toBe("ok");
		expect(code(state([["approved"]], "pending", 12))).toBe("ok");
	});

	it("[IMG-timestamp-required] item photos are reported before the timestamp photo", () => {
		expect(code(state([[]], null, 0))).toBe("missing_photos");
	});

	it("[IMG-timestamp-required] the Timestamped badge needs an approved timestamp photo", () => {
		expect(isTimestamped("approved")).toBe(true);
		for (const s of ["pending", "review", "rejected", null] as const) expect(isTimestamped(s)).toBe(false);
	});
});

describe("repeat offenders", () => {
	it("[IMG-repeat-offender] several rejected matches flag the account", () => {
		expect(isRepeatOffender(REPEAT_OFFENDER_REJECTIONS - 1)).toBe(false);
		expect(isRepeatOffender(REPEAT_OFFENDER_REJECTIONS)).toBe(true);
		expect(isRepeatOffender(REPEAT_OFFENDER_REJECTIONS + 4)).toBe(true);
	});
});
