import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	notifyMessagePosted,
	refreshLiveListings,
	requestAllowlistInvites,
	revokeLiveAccess,
	type NotifyRpc,
} from "./notify-rpc.ts";

function engine(answer: "ok" | "rejected" | "throws") {
	const calls: unknown[] = [];
	const respond = async (input: unknown) => {
		calls.push(input);
		if (answer === "throws") throw new Error("engine unreachable");
		return answer === "ok"
			? { ok: true as const, value: true }
			: { ok: false as const, error: { name: "Error", message: "bad input" } };
	};
	const rpc: NotifyRpc = {
		messagePosted: respond,
		sendAllowlistInvites: respond,
		listingsChanged: respond,
		revokeLiveViewers: respond,
	};
	return { rpc, calls };
}

describe("notification RPC from the web Worker", () => {
	it("[MSG-email-unread] tells the engine about a new message", async () => {
		const { rpc, calls } = engine("ok");
		expect(await Effect.runPromise(notifyMessagePosted(rpc, "m1"))).toBe(true);
		expect(calls).toEqual([{ messageId: "m1" }]);
	});

	it("[NOTIF-allowlist-invite] asks the engine to invite a saved invite list", async () => {
		const { rpc, calls } = engine("ok");
		expect(await Effect.runPromise(requestAllowlistInvites(rpc, "s1", "seller"))).toBe(true);
		expect(calls).toEqual([{ saleId: "s1", sellerId: "seller" }]);
	});

	it("[LIVE-broadcast] [LIVE-access] asks the engine to refresh live grids or revoke viewers", async () => {
		const { rpc, calls } = engine("ok");
		expect(await Effect.runPromise(refreshLiveListings(rpc, "s1", "seller"))).toBe(true);
		expect(await Effect.runPromise(revokeLiveAccess(rpc, "s1", "seller"))).toBe(true);
		expect(calls).toEqual([
			{ saleId: "s1", sellerId: "seller" },
			{ saleId: "s1", sellerId: "seller" },
		]);
	});

	it("never fails the user's action when the engine says no or can't be reached", async () => {
		for (const answer of ["rejected", "throws"] as const) {
			const { rpc } = engine(answer);
			expect(await Effect.runPromise(notifyMessagePosted(rpc, "m1"))).toBe(false);
			expect(await Effect.runPromise(requestAllowlistInvites(rpc, "s1", "seller"))).toBe(false);
			expect(await Effect.runPromise(refreshLiveListings(rpc, "s1", "seller"))).toBe(false);
			expect(await Effect.runPromise(revokeLiveAccess(rpc, "s1", "seller"))).toBe(false);
		}
	});
});
