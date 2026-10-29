import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevLoop, type DevLoopSteps } from "./dev-loop.ts";

/** Fake steps that record calls and fail the test if a build overlaps a running server. */
function fakeSteps(results: boolean[] = []) {
	const events: string[] = [];
	let serving = false;
	let release: (() => void) | undefined;
	let holdBuilds = false;
	const steps: DevLoopSteps = {
		async build() {
			if (serving) throw new Error("build started while the server was running");
			events.push("build");
			if (holdBuilds) await new Promise<void>((done) => (release = done));
			return results.shift() ?? true;
		},
		start() {
			serving = true;
			events.push("start");
		},
		async stop() {
			serving = false;
			events.push("stop");
		},
	};
	return {
		steps,
		events,
		hold: () => (holdBuilds = true),
		releaseBuild: () => {
			holdBuilds = false;
			release?.();
		},
	};
}

describe("createDevLoop", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("stops the server before every rebuild", async () => {
		const fake = fakeSteps();
		const loop = createDevLoop(fake.steps);
		await loop.start();
		loop.changed();
		await vi.runAllTimersAsync();
		expect(fake.events).toEqual(["build", "start", "stop", "build", "start"]);
	});

	it("debounces a burst of changes into one rebuild", async () => {
		const fake = fakeSteps();
		const loop = createDevLoop(fake.steps, 100);
		await loop.start();
		loop.changed();
		await vi.advanceTimersByTimeAsync(50);
		loop.changed();
		await vi.advanceTimersByTimeAsync(50);
		loop.changed();
		await vi.runAllTimersAsync();
		expect(fake.events.filter((e) => e === "build")).toHaveLength(2);
	});

	it("coalesces changes made during a rebuild into one more rebuild", async () => {
		const fake = fakeSteps();
		const loop = createDevLoop(fake.steps, 0);
		await loop.start();
		fake.hold();
		loop.changed();
		await vi.runAllTimersAsync();
		loop.changed();
		await vi.runAllTimersAsync();
		loop.changed();
		await vi.runAllTimersAsync();
		fake.releaseBuild();
		await vi.runAllTimersAsync();
		await loop.close();
		expect(fake.events).toEqual(["build", "start", "stop", "build", "build", "start", "stop"]);
	});

	it("leaves the server stopped after a failed build, until the next change", async () => {
		const fake = fakeSteps([true, false, true]);
		const loop = createDevLoop(fake.steps, 0);
		await loop.start();
		loop.changed();
		await vi.runAllTimersAsync();
		expect(fake.events).toEqual(["build", "start", "stop", "build"]);
		loop.changed();
		await vi.runAllTimersAsync();
		expect(fake.events).toEqual(["build", "start", "stop", "build", "build", "start"]);
	});

	it("stops the server on close, and only once", async () => {
		const fake = fakeSteps();
		const loop = createDevLoop(fake.steps);
		await loop.start();
		await loop.close();
		await loop.close();
		expect(fake.events).toEqual(["build", "start", "stop"]);
	});
});
