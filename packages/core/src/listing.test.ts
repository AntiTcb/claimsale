import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	canAddPhoto,
	canUseVisibility,
	FREE_PHOTO_CAP,
	imageCacheControl,
	isListed,
	photoCap,
	PRO_PHOTO_CAP,
	saleAccess,
	type SaleGate,
	type SaleVisibility,
	type Viewer,
} from "./listing.ts";
import type { SaleStatus } from "./sale.ts";

const gate = (over: Partial<SaleGate> = {}): SaleGate => ({
	sellerId: "seller",
	status: "scheduled",
	visibility: "unlisted",
	hasPassword: false,
	allowlistEnabled: false,
	...over,
});
const anon: Viewer = { userId: null, passwordUnlocked: false, allowlisted: false };
const someone: Viewer = { userId: "buyer", passwordUnlocked: false, allowlisted: false };
const seller: Viewer = { userId: "seller", passwordUnlocked: false, allowlisted: false };

describe("photo cap", () => {
	it("[SM-2-photo-cap] free sellers get 4 photos per item and Pro sellers 12", () => {
		expect(photoCap("free")).toBe(FREE_PHOTO_CAP);
		expect(photoCap("pro")).toBe(PRO_PHOTO_CAP);
		expect(canAddPhoto("free", 3)).toEqual({ ok: true, value: true });
		expect(canAddPhoto("free", 4)).toMatchObject({ ok: false, error: { code: "photo_cap_reached" } });
		expect(canAddPhoto("pro", 4)).toEqual({ ok: true, value: true });
		expect(canAddPhoto("pro", 12)).toMatchObject({ ok: false, error: { code: "photo_cap_reached" } });
	});
});

describe("sale visibility", () => {
	it("[SM-2-private-pro] private sales are Pro only; public and unlisted are free", () => {
		expect(canUseVisibility("free", "public").ok).toBe(true);
		expect(canUseVisibility("free", "unlisted").ok).toBe(true);
		expect(canUseVisibility("free", "private")).toMatchObject({ ok: false, error: { code: "pro_only" } });
		expect(canUseVisibility("pro", "private").ok).toBe(true);
	});

	it("[SM-2-visibility] a draft is seen only by its seller, and a deleted sale by no one", () => {
		expect(saleAccess(gate({ status: "draft" }), seller)).toBe("ok");
		expect(saleAccess(gate({ status: "draft" }), someone)).toBe("not_found");
		expect(saleAccess(gate({ status: "draft", visibility: "public" }), anon)).toBe("not_found");
		expect(saleAccess(gate({ status: "deleted" }), seller)).toBe("not_found");
	});

	it("[SM-2-visibility] public and unlisted sales are open to anyone with the link once published", () => {
		for (const status of ["scheduled", "live", "closed", "archived"] as const) {
			expect(saleAccess(gate({ status, visibility: "public" }), anon)).toBe("ok");
			expect(saleAccess(gate({ status, visibility: "unlisted" }), anon)).toBe("ok");
		}
	});

	it("[SM-2-visibility] a private sale needs the password or a verified allowlisted email", () => {
		const both = gate({ visibility: "private", hasPassword: true, allowlistEnabled: true });
		expect(saleAccess(both, anon)).toBe("locked");
		expect(saleAccess(both, someone)).toBe("locked");
		expect(saleAccess(both, { ...anon, passwordUnlocked: true })).toBe("ok");
		expect(saleAccess(both, { ...someone, allowlisted: true })).toBe("ok");
		expect(saleAccess(both, seller)).toBe("ok");
		// A method the seller didn't turn on never unlocks the sale.
		const passwordOnly = gate({ visibility: "private", hasPassword: true });
		expect(saleAccess(passwordOnly, { ...someone, allowlisted: true })).toBe("locked");
		const listOnly = gate({ visibility: "private", allowlistEnabled: true });
		expect(saleAccess(listOnly, { ...anon, passwordUnlocked: true })).toBe("locked");
	});

	it("[SM-2-visibility] only published public sales are listed and indexed", () => {
		expect(isListed({ status: "live", visibility: "public" })).toBe(true);
		expect(isListed({ status: "scheduled", visibility: "public" })).toBe(true);
		expect(isListed({ status: "live", visibility: "unlisted" })).toBe(false);
		expect(isListed({ status: "live", visibility: "private" })).toBe(false);
		expect(isListed({ status: "draft", visibility: "public" })).toBe(false);
		expect(isListed({ status: "deleted", visibility: "public" })).toBe(false);
	});

	it("[SM-2-private-images] private and draft sale photos are never publicly cacheable", () => {
		expect(imageCacheControl({ status: "live", visibility: "private" })).toBe("private, no-store");
		expect(imageCacheControl({ status: "draft", visibility: "public" })).toBe("private, no-store");
		expect(imageCacheControl({ status: "live", visibility: "unlisted" })).toMatch(/^public/);
	});

	it("[SM-2-visibility] property: no one but the seller ever sees a draft or an un-unlocked private sale", () => {
		const statuses: SaleStatus[] = ["draft", "scheduled", "live", "closed", "archived", "deleted"];
		const visibilities: SaleVisibility[] = ["public", "unlisted", "private"];
		const property = fc.property(
			fc.constantFrom(...statuses),
			fc.constantFrom(...visibilities),
			fc.boolean(),
			fc.boolean(),
			fc.option(fc.constantFrom("seller", "buyer")),
			fc.boolean(),
			fc.boolean(),
			(status, visibility, hasPassword, allowlistEnabled, userId, passwordUnlocked, allowlisted) => {
				const sale = gate({ status, visibility, hasPassword, allowlistEnabled });
				const viewer = { userId, passwordUnlocked, allowlisted };
				if (saleAccess(sale, viewer) !== "ok") return true;
				if (status === "deleted") return false;
				if (userId === "seller") return true;
				const unlocked = (hasPassword && passwordUnlocked) || (allowlistEnabled && allowlisted);
				return status !== "draft" && (visibility !== "private" || unlocked);
			},
		);
		expect(() => fc.assert(property)).not.toThrow();
	});
});
