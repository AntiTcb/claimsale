<script lang="ts">
	import { formatCents, type LiveSnapshot, type MyEntry, type SaleStatus } from "@claimsale/core";
	import { untrack } from "svelte";
	import EntryDialog from "./EntryDialog.svelte";
	import LiveFilters from "./LiveFilters.svelte";
	import LiveItemCard from "./LiveItemCard.svelte";
	import { entryActionRequest, placeEntryRequest, type RequestResult } from "#lib/live/entry-requests.ts";
	import { LiveGrid } from "#lib/live/live-grid.svelte.ts";
	import type { EntryAction } from "#lib/live/state.ts";
	import { matchesFilter, NO_FILTER, type GridFilter, type GridItem } from "#lib/live/state.ts";

	/**
	 * The live grid of a sale page (WS-H, PLAN §5 and §8): the items with their live
	 * counts and the viewer's positions, kept current over the sale's WebSocket; claim
	 * and offer buttons with the binding-claim confirmation; filters; the buyer's
	 * running total (D53); and a live region that reads out claim results.
	 */
	interface Props {
		saleId: string;
		slug: string;
		/** The sale's status at page load; the socket updates it. */
		status: SaleStatus;
		items: readonly GridItem[];
		live: LiveSnapshot | null;
		/** The seller's terms: ask before each claim (on by default). */
		confirmClaims: boolean;
		signedIn: boolean;
		isSeller: boolean;
		/** Refetches the page load (SvelteKit's invalidateAll): a fresh snapshot without the socket. */
		refresh: () => Promise<unknown>;
	}

	let { saleId, slug, status, items, live, confirmClaims, signedIn, isSeller, refresh }: Props = $props();

	const grid = new LiveGrid(
		untrack(() => live),
		{
			titles: untrack(() => Object.fromEntries(items.map((i) => [i.id, i.title]))),
			onStale: () => void refresh(),
		},
	);

	// The page's items after a refetch (before its snapshot below), so a deleted item doesn't
	// look missing again and an added one isn't unknown.
	$effect(() => {
		grid.setTitles(Object.fromEntries(items.map((i) => [i.id, i.title])));
	});

	// A refetched page load (after a claim without the socket, or onStale) is a fresh snapshot.
	let lastSnapshot = untrack(() => live);
	$effect(() => {
		if (live && live !== lastSnapshot) {
			lastSnapshot = live;
			grid.apply({ type: "snapshot", ...live });
		}
	});

	$effect(() => {
		if (!untrack(() => live)) return;
		const scheme = location.protocol === "https:" ? "wss" : "ws";
		grid.connect(`${scheme}://${location.host}/api/sales/${encodeURIComponent(saleId)}/live`);
		return () => grid.stop();
	});

	// A clock on the server's time, for the go-live countdown.
	let now = $state(Date.now());
	$effect(() => {
		const tick = setInterval(() => (now = grid.now()), 1000);
		return () => clearInterval(tick);
	});

	const saleStatus = $derived(grid.sale?.status ?? status);
	const liveAt = $derived(grid.sale?.liveAt ?? live?.sale.liveAt ?? null);
	const mode = $derived(
		isSeller || (saleStatus !== "live" && saleStatus !== "scheduled")
			? ("none" as const)
			: saleStatus === "scheduled"
				? ("soon" as const)
				: signedIn
					? ("enter" as const)
					: ("sign_in" as const),
	);
	const total = $derived(grid.total);
	const games = $derived([...new Set(items.map((i) => i.gameId))]);

	let filter: GridFilter = $state(NO_FILTER);
	const shown = $derived(items.filter((item) => matchesFilter(item, grid.items[item.id], filter)));

	let busy: Record<string, boolean> = $state({});
	let request: { kind: "claim" | "offer"; itemId: string; title: string; priceCents: number } | null =
		$state(null);

	function countdown(ms: number): string {
		const s = Math.max(0, Math.floor(ms / 1000));
		const d = Math.floor(s / 86_400);
		const h = Math.floor((s % 86_400) / 3600);
		const m = Math.floor((s % 3600) / 60);
		if (d > 0) return `${d}d ${h}h`;
		if (h > 0) return `${h}h ${m}m`;
		return `${m}m ${s % 60}s`;
	}

	/** @spec LIVE-claim-confirm — a claim is confirmed first unless the seller turned that off. */
	function ask(kind: "claim" | "offer", item: GridItem) {
		if (kind === "claim" && !confirmClaims) {
			void place(item.id, "claim");
			return;
		}
		request = { kind, itemId: item.id, title: item.title, priceCents: item.priceCents };
	}

	/** Runs one request for an item; the socket brings the result ("You're #1"), else a refetch. */
	async function send(itemId: string, run: () => Promise<RequestResult>) {
		busy = { ...busy, [itemId]: true };
		try {
			const result = await run();
			if (!result.ok) grid.announce(result.message);
			else if (grid.connection !== "live") await refresh();
		} finally {
			busy = { ...busy, [itemId]: false };
		}
	}

	function place(itemId: string, kind: "claim" | "offer", amountCents?: number) {
		return send(itemId, () => placeEntryRequest(saleId, itemId, kind, amountCents));
	}

	/** The buyer's own entry: withdraw an offer, leave the backup queue, answer a counter (§4.4). */
	function act(itemId: string, action: EntryAction, entry: MyEntry) {
		return send(itemId, () => entryActionRequest(saleId, itemId, entry.id, action));
	}
</script>

<div class="mt-8 flex flex-col gap-4">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="text-lg font-semibold">{items.length} item{items.length === 1 ? "" : "s"}</h2>
		<p class="text-sm text-zinc-600 dark:text-zinc-400" data-testid="connection">
			{#if !live}
				Live updates are unavailable; reload for the latest.
			{:else if grid.connection === "live"}
				Live
			{:else if grid.connection === "offline"}
				Reconnecting…
			{:else if grid.connection === "connecting"}
				Connecting…
			{/if}
		</p>
	</div>

	{#if saleStatus === "scheduled" && liveAt !== null}
		<p class="rounded-md bg-sky-50 p-3 text-sky-950 dark:bg-sky-950 dark:text-sky-100">
			Claims open in <span role="timer" aria-live="off">{countdown(liveAt - now)}</span>.
		</p>
	{/if}

	{#if signedIn && !isSeller && total.count > 0}
		<p
			class="sticky top-0 z-10 rounded-md bg-green-50 p-3 font-medium text-green-950 dark:bg-green-950 dark:text-green-100"
			data-testid="running-total"
		>
			Your total: {formatCents(total.cents)} · {total.count} item{total.count === 1 ? "" : "s"} won
		</p>
	{/if}

	<LiveFilters {filter} {games} showMine={signedIn && !isSeller} onchange={(next) => (filter = next)} />

	{#if shown.length === 0}
		<p class="text-zinc-600 dark:text-zinc-400">No items match these filters.</p>
	{/if}
	<ul class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
		{#each shown as item (item.id)}
			<li>
				<LiveItemCard
					href="/s/{slug}/i/{item.id}"
					title={item.title}
					priceCents={item.priceCents}
					quantity={item.quantity}
					gameId={item.gameId}
					kind={item.kind}
					condition={item.condition}
					photoUrl={item.photoUrl}
					state={item.state}
					offersEnabled={item.offersEnabled}
					live={grid.items[item.id]}
					{mode}
					signInHref="/login?next=/s/{slug}"
					busy={busy[item.id] ?? false}
					{now}
					onclaim={() => ask("claim", item)}
					onoffer={() => ask("offer", item)}
					onaction={(action, entry) => void act(item.id, action, entry)}
				/>
			</li>
		{/each}
	</ul>
</div>

<p
	role="status"
	aria-live="polite"
	data-testid="live-announcement"
	class="fixed inset-x-4 bottom-4 z-20 mx-auto max-w-md rounded-md bg-zinc-900 p-3 text-center text-white shadow-lg empty:hidden dark:bg-zinc-100 dark:text-zinc-900"
>
	{#key grid.announcementId}{grid.announcement}{/key}
</p>

<EntryDialog
	request={request && { kind: request.kind, title: request.title, priceCents: request.priceCents }}
	oncancel={() => (request = null)}
	onconfirm={(amountCents) => {
		const r = request;
		request = null;
		if (r) void place(r.itemId, r.kind, amountCents);
	}}
/>
