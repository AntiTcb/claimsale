import { describe, expect, it } from "vitest";
import { formatDate, isTimeZone } from "./dates.ts";

describe("formatDate", () => {
	const at = Date.UTC(2026, 10, 20, 23, 10); // 6:10 PM in New York

	it("formats in the zone it's given, not the runtime's", () => {
		expect(formatDate(at, "dateTime", "America/New_York")).toBe("Nov 20, 2026, 6:10 PM");
		expect(formatDate(at, "dateTime", "UTC")).toBe("Nov 20, 2026, 11:10 PM");
		expect(formatDate(at, "date", "Asia/Tokyo")).toBe("Nov 21, 2026");
	});

	it("has a style for each kind of date on the pages", () => {
		expect(formatDate(at, "fullDateTime", "America/New_York")).toBe("Friday, November 20, 2026 at 6:10 PM");
		expect(formatDate(at, "short", "America/New_York")).toBe("Nov 20, 6:10 PM");
		expect(formatDate(at, "monthYear", "America/New_York")).toBe("November 2026");
	});

	it("uses plain spaces, so the server's and the browser's text match", () => {
		expect(formatDate(at, "dateTime", "UTC")).not.toMatch(/[\u202F\u00A0]/);
	});
});

describe("isTimeZone", () => {
	it("accepts IANA zones and rejects anything else from the cookie", () => {
		expect(isTimeZone("America/Chicago")).toBe(true);
		expect(isTimeZone("UTC")).toBe(true);
		expect(isTimeZone(undefined)).toBe(false);
		expect(isTimeZone("")).toBe(false);
		expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
		expect(isTimeZone("x".repeat(65))).toBe(false);
	});
});
