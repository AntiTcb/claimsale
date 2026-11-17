<script lang="ts">
	import {
		formatCents,
		MARKET_PERCENT_PRESETS,
		previewBulkMarketPrice,
		type BulkPricePreview,
	} from "@claimsale/core";

	/**
	 * "Set all selected / blank prices to N % of market" (D64), always previewed:
	 * pick a %, see every change, then apply exactly that preview (TCG-market-pct).
	 */
	interface Candidate {
		readonly id: string;
		readonly label: string;
		readonly priceCents: number | null;
		readonly marketCents: number | null;
		readonly selected?: boolean;
	}

	interface Props {
		candidates: readonly Candidate[];
		scope: "selected" | "blank";
		defaultPercent: number | null;
		onapply: (preview: BulkPricePreview) => void;
		disabled?: boolean;
	}

	let { candidates, scope, defaultPercent, onapply, disabled = false }: Props = $props();

	let percent = $state<number>(0);
	let preview = $state<BulkPricePreview | null>(null);
	const labels = $derived(new Map(candidates.map((c) => [c.id, c.label])));
	const inScope = $derived(
		candidates.filter((c) => (scope === "selected" ? c.selected === true : c.priceCents === null)).length,
	);
	const noMarket = $derived(preview?.skipped.filter((s) => s.reason === "no_market").length ?? 0);
	const what = $derived(scope === "blank" ? "blank prices" : "selected prices");

	function show(next: number) {
		percent = next;
		preview = previewBulkMarketPrice(
			candidates.map((c) => ({
				itemId: c.id,
				priceCents: c.priceCents,
				selected: c.selected === true,
				marketCents: c.marketCents,
			})),
			next,
			scope,
		);
	}

	function apply() {
		if (!preview || preview.changes.length === 0) return;
		onapply(preview);
		preview = null;
	}
</script>

<section
	class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
	aria-label="Set {what} to a % of market"
	data-testid="bulk-market"
>
	<p class="text-sm font-medium">
		Set {inScope}
		{what} to a % of TCGplayer market
	</p>
	<div class="mt-2 flex flex-wrap gap-1" role="group" aria-label="Percent of market">
		{#each MARKET_PERCENT_PRESETS as p (p)}
			<button
				type="button"
				aria-pressed={preview !== null && percent === p}
				class="rounded border px-2 py-1 text-sm disabled:opacity-50 {p === defaultPercent
					? 'border-zinc-900 font-semibold dark:border-zinc-100'
					: 'border-zinc-400'} {preview !== null && percent === p
					? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
					: ''}"
				disabled={disabled || inScope === 0}
				onclick={() => show(p)}
				>{p}%<span class="sr-only">{p === defaultPercent ? " (your default)" : ""}</span></button
			>
		{/each}
	</div>

	{#if preview}
		<div class="mt-3" role="region" aria-label="Preview at {preview.percent}% of market">
			{#if preview.changes.length === 0}
				<p class="text-sm">Nothing to change at {preview.percent}% of market.</p>
			{:else}
				<ul class="max-h-60 overflow-auto text-sm">
					{#each preview.changes as change (change.itemId)}
						<li>
							{labels.get(change.itemId) ?? change.itemId}:
							{change.fromCents === null ? "no price" : formatCents(change.fromCents)} →
							<strong>{formatCents(change.toCents)}</strong>
						</li>
					{/each}
				</ul>
			{/if}
			{#if noMarket > 0}
				<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
					{noMarket} without a market price {noMarket === 1 ? "stays" : "stay"} as {noMarket === 1
						? "it is"
						: "they are"}.
				</p>
			{/if}
			<div class="mt-2 flex gap-2">
				<button
					type="button"
					class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
					disabled={disabled || preview.changes.length === 0}
					onclick={apply}
					>Apply to {preview.changes.length} item{preview.changes.length === 1 ? "" : "s"}</button
				>
				<button type="button" class="px-3 py-1.5 text-sm underline" onclick={() => (preview = null)}
					>Cancel</button
				>
			</div>
		</div>
	{/if}
	<p class="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
		Market is about a near-mint price for each finish; adjust for condition. Buyers never see it.
	</p>
</section>
