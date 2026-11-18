<script lang="ts">
	import {
		formatCents,
		type ItemState,
		type LiveSnapshot,
		type MyEntry,
		type SaleStatus,
	} from "@claimsale/core";
	import { untrack } from "svelte";
	import EntryControls from "./EntryControls.svelte";
	import EntryDialog from "./EntryDialog.svelte";
	import { entryActionRequest, placeEntryRequest, type RequestResult } from "#lib/live/entry-requests.ts";
	import { LiveGrid } from "#lib/live/live-grid.svelte.ts";
	import type { EntryAction } from "#lib/live/state.ts";

	/**
	 * Claim, offer and the buyer's own entry on the item page (/s/[slug]/i/[itemId], WS-M2):
	 * the same controls and live updates as the sale's grid, following this one item.
	 */
	interface Props {
		saleId: string;
		item: {
			readonly id: string;
			readonly title: string;
			readonly priceCents: number;
			readonly state: ItemState;
			readonly offersEnabled: boolean;
		};
		/** The sale's status at page load; the socket updates it. */
		status: SaleStatus;
		live: LiveSnapshot | null;
		confirmClaims: boolean;
		signedIn: boolean;
		isSeller: boolean;
		signInHref: string;
		/** Refetches the page load (SvelteKit's invalidateAll). */
		refresh: () => Promise<unknown>;
	}

	let { saleId, item, status, live, confirmClaims, signedIn, isSeller, signInHref, refresh }: Props =
		$props();

	const grid = new LiveGrid(
		untrack(() => live),
		{
			titles: untrack(() => ({ [item.id]: item.title })),
			itemId: untrack(() => item.id),
			onStale: () => void refresh(),
		},
	);

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

	let now = $state(Date.now());
	$effect(() => {
		const tick = setInterval(() => (now = grid.now()), 1000);
		return () => clearInterval(tick);
	});

	const itemLive = $derived(grid.items[item.id]);
	const saleStatus = $derived(grid.sale?.status ?? status);
	const mode = $derived(
		isSeller || (saleStatus !== "live" && saleStatus !== "scheduled")
			? ("none" as const)
			: saleStatus === "scheduled"
				? ("soon" as const)
				: signedIn
					? ("enter" as const)
					: ("sign_in" as const),
	);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

	let busy = $state(false);
	let request: "claim" | "offer" | null = $state(null);

	async function send(run: () => Promise<RequestResult>) {
		busy = true;
		try {
			const result = await run();
			if (!result.ok) grid.announce(result.message);
			else if (grid.connection !== "live") await refresh();
		} finally {
			busy = false;
		}
	}

	/** @spec LIVE-claim-confirm — a claim is confirmed first unless the seller turned that off. */
	function ask(kind: "claim" | "offer") {
		if (kind === "claim" && !confirmClaims) void send(() => placeEntryRequest(saleId, item.id, "claim"));
		else request = kind;
	}

	function act(action: EntryAction, entry: MyEntry) {
		void send(() => entryActionRequest(saleId, item.id, entry.id, action));
	}
</script>

<div class="mt-4 flex flex-col gap-1" data-testid="item-live">
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
	{#if itemLive && itemLive.claimCount + itemLive.offerCount > 0}
		<p class="text-sm text-zinc-700 dark:text-zinc-300" data-testid="item-counts">
			{plural(itemLive.claimCount, "claim")} waiting · {plural(itemLive.offerCount, "offer")}
		</p>
	{/if}
	{#if itemLive && itemLive.offers.length > 0}
		<ul class="text-sm text-zinc-700 dark:text-zinc-300" aria-label="Offers on {item.title}">
			{#each itemLive.offers as offer (offer.label)}
				<li>{offer.label}: {formatCents(offer.amountCents)}</li>
			{/each}
		</ul>
	{/if}
	<EntryControls
		title={item.title}
		state={itemLive?.state ?? item.state}
		offersEnabled={item.offersEnabled}
		live={itemLive}
		{mode}
		{signInHref}
		{busy}
		{now}
		onclaim={() => ask("claim")}
		onoffer={() => ask("offer")}
		onaction={act}
	/>
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
	request={request && { kind: request, title: item.title, priceCents: item.priceCents }}
	oncancel={() => (request = null)}
	onconfirm={(amountCents) => {
		const kind = request;
		request = null;
		if (kind) void send(() => placeEntryRequest(saleId, item.id, kind, amountCents));
	}}
/>
