/** What the dev loop drives: a one-off build, and the local server that serves its output. */
export interface DevLoopSteps {
	/** Builds the app once; resolves to whether the build succeeded. */
	readonly build: () => Promise<boolean>;
	/** Starts the server on the latest build output. */
	readonly start: () => void;
	/** Stops the server and resolves once it has exited. */
	readonly stop: () => Promise<void>;
}

export interface DevLoop {
	/** Runs the first build and starts the server. */
	readonly start: () => Promise<void>;
	/** Reports a source change; bursts within `debounceMs` become one rebuild. */
	readonly changed: () => void;
	/** Waits for any rebuild in progress, then stops the server. */
	readonly close: () => Promise<void>;
}

/**
 * Rebuild-and-restart loop for `pnpm dev`. The server is always stopped before a build
 * starts: adapter-cloudflare deletes its output directory on every build, which fails
 * with EPERM on Windows while wrangler holds it open. Changes that arrive during a
 * rebuild are coalesced into one more rebuild.
 */
export function createDevLoop(steps: DevLoopSteps, debounceMs = 150): DevLoop {
	let serving = false;
	let cycle: Promise<void> | undefined;
	let again = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Each step depends on the previous one finishing, so awaiting in the loop is intended.
	/* oxlint-disable no-await-in-loop */
	async function rebuild(): Promise<void> {
		do {
			again = false;
			if (serving) {
				await steps.stop();
				serving = false;
			}
			// A change during the build means another build follows; skip starting in between.
			if ((await steps.build()) && !again) {
				steps.start();
				serving = true;
			}
		} while (again);
	}
	/* oxlint-enable no-await-in-loop */

	function kick(): Promise<void> {
		if (cycle) {
			again = true;
			return cycle;
		}
		cycle = rebuild().finally(() => {
			cycle = undefined;
		});
		return cycle;
	}

	return {
		start: kick,
		changed() {
			clearTimeout(timer);
			timer = setTimeout(() => void kick(), debounceMs);
		},
		async close() {
			clearTimeout(timer);
			await cycle;
			if (serving) {
				await steps.stop();
				serving = false;
			}
		},
	};
}
