<script lang="ts">
	import { formatCents, type MarketHint } from "@claimsale/core";

	/**
	 * The % of market buttons under a price field (D64). The parent shows
	 * `hint.placeholder` as the field's placeholder; nothing is filled in until the
	 * seller clicks a button (TCG-market-placeholder), and they can still edit it.
	 */
	interface Props {
		hint: MarketHint | null;
		/** Used in labels, e.g. "Set the price of Charizard to 80 % of market". */
		itemTitle?: string;
		onpick: (priceCents: number, percent: number) => void;
		disabled?: boolean;
	}

	let { hint, itemTitle = "", onpick, disabled = false }: Props = $props();
	const of = $derived(itemTitle ? ` of ${itemTitle}` : "");
</script>

{#if hint}
	<div class="mt-1 flex flex-col gap-1" data-testid="market-aid">
		<div class="flex flex-wrap gap-1" role="group" aria-label="Price{of} as a % of market">
			{#each hint.presets as preset (preset.percent)}
				{@const isDefault = preset.percent === hint.highlightedPercent}
				<button
					type="button"
					class="rounded border px-1.5 py-0.5 text-xs disabled:opacity-50 {isDefault
						? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
						: 'border-zinc-400'}"
					aria-label="Set the price{of} to {preset.percent}% of market, {formatCents(
						preset.priceCents,
					)}{isDefault ? ' (your default)' : ''}"
					title={formatCents(preset.priceCents)}
					{disabled}
					onclick={() => onpick(preset.priceCents, preset.percent)}>{preset.percent}%</button
				>
			{/each}
		</div>
		<p class="text-xs text-zinc-600 dark:text-zinc-400">
			TCGplayer market is about a near-mint price for this finish; adjust for condition. Buyers never see it.
		</p>
	</div>
{/if}
