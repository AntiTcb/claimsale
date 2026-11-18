<script lang="ts">
	import { formatCents, type ItemState, type LiveItem } from "@claimsale/core";
	import { describeItem } from "#lib/listing-input.ts";
	import { currentEntry, positionLabel } from "#lib/live/state.ts";

	/**
	 * One item in the live grid (/s/[slug], WS-H): the item, its public counts, the offer
	 * amounts the sale shows, the viewer's own position, and the claim and offer buttons.
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
		onclaim?: () => void;
		onoffer?: () => void;
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
		onclaim,
		onoffer,
	}: Props = $props();

	const STATE_LABELS: Record<ItemState, string | null> = {
		available: null,
		deciding: "Seller deciding",
		sold_out: "Sold out",
		withdrawn: "Withdrawn",
		unsold: "Unsold",
	};

	const shown = $derived(live?.state ?? state);
	const mine = $derived(currentEntry(live));
	const pending = $derived(mine?.status === "open" || mine?.status === "countered");
	const closedForEntries = $derived(shown === "withdrawn" || shown === "unsold");
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
		{#if mine}
			<p
				class="self-start rounded-full px-2 py-0.5 text-sm font-semibold {mine.position.kind === 'won'
					? 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100'
					: mine.position.kind === 'ended'
						? 'bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200'
						: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100'}"
				data-testid="my-position"
			>
				{positionLabel(mine)}
			</p>
		{/if}

		{#if mode === "enter" && !closedForEntries}
			<div class="mt-2 flex flex-wrap gap-2">
				<button
					type="button"
					class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
					disabled={busy || pending}
					onclick={() => onclaim?.()}
				>
					{busy ? "Claiming…" : shown === "sold_out" ? "Claim as backup" : "Claim"}<span class="sr-only"
						>{` ${title}`}</span
					>
				</button>
				{#if offersEnabled}
					<button
						type="button"
						class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium disabled:opacity-60 dark:border-zinc-700"
						disabled={busy || pending}
						onclick={() => onoffer?.()}
					>
						Make an offer<span class="sr-only">{` on ${title}`}</span>
					</button>
				{/if}
			</div>
		{:else if mode === "soon"}
			<button
				type="button"
				disabled
				class="mt-2 self-start rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
				>Claims open soon<span class="sr-only">{` for ${title}`}</span></button
			>
		{:else if mode === "sign_in" && !closedForEntries}
			<a href={signInHref} class="mt-2 self-start text-sm font-medium underline">Sign in to claim</a>
		{/if}
	</div>
</article>
