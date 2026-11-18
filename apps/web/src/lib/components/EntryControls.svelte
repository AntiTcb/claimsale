<script lang="ts">
	import type { ItemState, LiveItem, MyEntry } from "@claimsale/core";
	import {
		currentEntry,
		entryActionLabel,
		entryActions,
		positionLabel,
		type EntryAction,
	} from "#lib/live/state.ts";

	/**
	 * The buyer's part of one item, on the grid card and the item page (WS-H, WS-M2): their
	 * position, the claim and offer buttons, and what they can do with their own entry —
	 * withdraw an offer, leave the backup queue, or answer a counter.
	 */
	interface Props {
		title: string;
		/** The item's state now (live, else from the page load). */
		state: ItemState;
		offersEnabled: boolean;
		live?: LiveItem | undefined;
		/**
		 * `enter` (claim or offer), `soon` (the sale isn't live yet), `sign_in`, or `none`
		 * (closed, or the viewer is the seller).
		 */
		mode: "enter" | "soon" | "sign_in" | "none";
		signInHref?: string;
		/** A request about this item is on its way. */
		busy?: boolean;
		/** The server's clock, for a counter's expiry. */
		now: number;
		onclaim?: (() => void) | undefined;
		onoffer?: (() => void) | undefined;
		onaction?: ((action: EntryAction, entry: MyEntry) => void) | undefined;
	}

	let {
		title,
		state,
		offersEnabled,
		live,
		mode,
		signInHref = "/login",
		busy = false,
		now,
		onclaim,
		onoffer,
		onaction,
	}: Props = $props();

	const mine = $derived(currentEntry(live));
	const pending = $derived(mine?.status === "open" || mine?.status === "countered");
	const closedForEntries = $derived(state === "withdrawn" || state === "unsold");
	const actions = $derived(mode === "enter" ? entryActions(mine, now) : []);
</script>

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
			{busy && !pending ? "Claiming…" : state === "sold_out" ? "Claim as backup" : "Claim"}<span
				class="sr-only">{` ${title}`}</span
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

{#if mine && actions.length > 0}
	<div class="mt-2 flex flex-wrap gap-2" data-testid="entry-actions">
		{#each actions as action (action)}
			<button
				type="button"
				class="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60 {action ===
				'accept_counter'
					? 'border-green-700 text-green-900 dark:border-green-400 dark:text-green-100'
					: 'border-zinc-300 dark:border-zinc-700'}"
				disabled={busy}
				onclick={() => onaction?.(action, mine)}
			>
				{entryActionLabel(action, mine)}<span class="sr-only">{` for ${title}`}</span>
			</button>
		{/each}
	</div>
{/if}
