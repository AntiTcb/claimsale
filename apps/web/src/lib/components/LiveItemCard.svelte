<script lang="ts">
	import { formatCents, type ItemState, type LiveItem, type MyEntry } from "@claimsale/core";
	import { describeItem } from "#lib/listing-input.ts";
	import type { EntryAction } from "#lib/live/state.ts";
	import EntryControls from "./EntryControls.svelte";

	/**
	 * One item in the live grid (/s/[slug], WS-H): the item, its public counts, the offer
	 * amounts the sale shows, and the buyer's controls (EntryControls).
	 */
	interface Props {
		href: string;
		title: string;
		priceCents: number;
		quantity: number;
		gameId: string;
		kind: string;
		condition: string | null;
		photoUrl: string | null;
		/** The cached state from the page load, until `live` says otherwise. */
		state: ItemState;
		offersEnabled: boolean;
		/** The engine's projection for this viewer; undefined when live data isn't available. */
		live?: LiveItem | undefined;
		/**
		 * What the viewer can do: `enter` (claim or offer), `soon` (the sale isn't live yet),
		 * `sign_in`, or `none` (closed, or the viewer is the seller).
		 */
		mode: "enter" | "soon" | "sign_in" | "none";
		signInHref?: string;
		/** A claim or offer on this item is on its way. */
		busy?: boolean;
		/** The server's clock, for a counter's expiry. */
		now?: number;
		onclaim?: () => void;
		onoffer?: () => void;
		onaction?: (action: EntryAction, entry: MyEntry) => void;
	}

	let {
		href,
		title,
		priceCents,
		quantity,
		gameId,
		kind,
		condition,
		photoUrl,
		state,
		offersEnabled,
		live,
		mode,
		signInHref = "/login",
		busy = false,
		now = Date.now(),
		onclaim,
		onoffer,
		onaction,
	}: Props = $props();

	const STATE_LABELS: Record<ItemState, string | null> = {
		available: null,
		deciding: "Seller deciding",
		sold_out: "Sold out",
		withdrawn: "Withdrawn",
		unsold: "Unsold",
	};

	const shown = $derived(live?.state ?? state);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
</script>

<article
	class="flex flex-col overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
	data-testid="live-item"
	data-item-id={live?.id}
>
	<a {href} class="block" tabindex="-1" aria-hidden="true">
		{#if photoUrl}
			<img
				src={photoUrl}
				alt=""
				class="aspect-square w-full bg-zinc-100 object-cover dark:bg-zinc-900"
				loading="lazy"
			/>
		{:else}
			<div
				class="flex aspect-square w-full items-center justify-center bg-zinc-100 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
			>
				No photo yet
			</div>
		{/if}
	</a>
	<div class="flex flex-1 flex-col gap-1 p-3">
		<h3 class="font-medium leading-snug"><a {href} class="hover:underline">{title}</a></h3>
		<p class="text-sm text-zinc-600 dark:text-zinc-400">{describeItem(gameId, kind, condition)}</p>
		<p class="mt-auto flex items-baseline justify-between pt-1">
			<span class="text-lg font-semibold">{formatCents(priceCents)}</span>
			{#if quantity > 1}<span class="text-sm text-zinc-600 dark:text-zinc-400"
					>{live ? `${live.freeUnits} of ${quantity} left` : `${quantity} available`}</span
				>{/if}
		</p>
		{#if STATE_LABELS[shown]}
			<p class="text-sm font-medium" data-testid="item-state">{STATE_LABELS[shown]}</p>
		{/if}
		{#if live && live.claimCount + live.offerCount > 0}
			<p class="text-sm text-zinc-700 dark:text-zinc-300" data-testid="item-counts">
				{plural(live.claimCount, "claim")} waiting · {plural(live.offerCount, "offer")}
			</p>
		{/if}
		{#if live && live.offers.length > 0}
			<ul class="text-sm text-zinc-700 dark:text-zinc-300" aria-label="Offers on {title}">
				{#each live.offers as offer (offer.label)}
					<li>{offer.label}: {formatCents(offer.amountCents)}</li>
				{/each}
			</ul>
		{/if}
		<EntryControls
			{title}
			state={shown}
			{offersEnabled}
			{live}
			{mode}
			{signInHref}
			{busy}
			{now}
			{onclaim}
			{onoffer}
			{onaction}
		/>
	</div>
</article>
