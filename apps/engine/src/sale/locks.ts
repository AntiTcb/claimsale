/**
 * In-memory keyed locks for one SaleEngine instance (STATE_MACHINES §9).
 *
 * A Durable Object's input gates don't hold across D1 calls (D1 is a network hop,
 * not the object's own storage), so two commands can interleave between their read
 * and their write. Every command takes the locks of what it reads and writes:
 *
 * - `sale`: the sale row (publish, go-live, close),
 * - `item:<id>`: one item and its entries,
 * - `invoices`: the sale's invoices.
 *
 * Keys are always taken in one global order (see `lockOrder`), so commands can't
 * deadlock. A command may take more keys later only if they sort after every key it
 * holds; the engine only does this for `invoices`, which sorts last.
 *
 * @spec SM-9-serialized-writes — commands on one item run one at a time; commands on
 * different items run in parallel.
 */

export type LockKey = "sale" | `item:${string}` | "invoices";

const rank = (key: LockKey) => (key === "sale" ? 0 : key === "invoices" ? 2 : 1);

/** sale < item:* (by ID) < invoices. */
export function lockOrder(a: LockKey, b: LockKey): number {
	return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

export const itemKey = (itemId: string): LockKey => `item:${itemId}`;

export class KeyedLocks {
	/** The tail of each key's queue: resolves when the last holder releases. */
	readonly #tails = new Map<LockKey, Promise<void>>();

	/** Waits for every key (in lock order) and returns a function that releases them all. */
	async acquire(keys: Iterable<LockKey>): Promise<() => void> {
		const ordered = [...new Set(keys)].toSorted(lockOrder);
		const releases: Array<() => void> = [];
		for (const key of ordered) releases.push(await this.#acquireOne(key));
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const release of releases.toReversed()) release();
		};
	}

	/** Runs `fn` holding `keys`. */
	async with<T>(keys: Iterable<LockKey>, fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire(keys);
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/** Keys someone holds or waits for (tests and diagnostics). */
	get busy(): number {
		return this.#tails.size;
	}

	async #acquireOne(key: LockKey): Promise<() => void> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => (release = resolve));
		const tail = previous.then(() => mine);
		this.#tails.set(key, tail);
		await previous;
		return () => {
			release();
			// Nobody queued behind us: forget the key so the map doesn't grow with every item.
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		};
	}
}
