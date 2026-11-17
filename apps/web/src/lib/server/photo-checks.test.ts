import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { requestPhotoCheck, reviewHeldPhoto, type PhotoRpc } from "./photo-checks.ts";

type Request = PhotoRpc["requestPhotoVerification"];
type Review = PhotoRpc["reviewPhoto"];

function engine(overrides: { request?: Request; review?: Review } = {}) {
	const request = vi.fn<Request>(overrides.request ?? (async () => ({ ok: true, value: true })));
	const review = vi.fn<Review>(overrides.review ?? (async () => ({ ok: true, value: true })));
	const rpc: PhotoRpc = { requestPhotoVerification: request, reviewPhoto: review };
	return { rpc, request, review };
}

describe("photo checks over RPC", () => {
	it("[IMG-dup-reject] queues the check of an upload", async () => {
		const { rpc, request } = engine();
		expect(await Effect.runPromise(requestPhotoCheck(rpc, "img-1"))).toBe(true);
		expect(request).toHaveBeenCalledWith({ imageId: "img-1" });
	});

	it("[IMG-dup-reject] never fails the upload when the engine is unreachable or refuses", async () => {
		const down = engine({
			request: async () => {
				throw new Error("service binding unavailable");
			},
		});
		expect(await Effect.runPromise(requestPhotoCheck(down.rpc, "img-1"))).toBe(false);
		const refused = engine({
			request: async () => ({ ok: false, error: { name: "QueueError", message: "full" } }),
		});
		expect(await Effect.runPromise(requestPhotoCheck(refused.rpc, "img-1"))).toBe(false);
	});

	it("[IMG-dup-review] passes an admin's decision through, and fails when the engine does", async () => {
		const { rpc, review } = engine();
		const input = { imageId: "img-1", adminId: "admin", decision: "approved" as const };
		expect(await Effect.runPromise(reviewHeldPhoto(rpc, input))).toBe(true);
		expect(review).toHaveBeenCalledWith(input);
		const failing = engine({
			review: async () => ({ ok: false, error: { name: "PhotoDbError", message: "D1 down" } }),
		});
		expect(Exit.isFailure(await Effect.runPromiseExit(reviewHeldPhoto(failing.rpc, input)))).toBe(true);
	});
});
