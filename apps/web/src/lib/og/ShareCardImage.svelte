<script lang="ts">
	import { SHARE_CARD_STATUS_LABELS, type ShareCard } from "@claimsale/core";

	/**
	 * The 1200×630 share image for a sale (WS-L2, TECH_STACK S13). Satori renders it, so it
	 * takes inline styles only, and every element with more than one child is a flexbox.
	 */
	let { card }: { card: ShareCard } = $props();

	const STATUS_COLORS = {
		upcoming: { bg: "#dbeafe", fg: "#1e3a8a" },
		live: { bg: "#dcfce7", fg: "#14532d" },
		closed: { bg: "#e4e4e7", fg: "#3f3f46" },
	};
	const status = $derived(STATUS_COLORS[card.status]);
	const count = $derived(`${card.itemCount} ${card.itemCount === 1 ? "item" : "items"}`);
</script>

<div
	style="display: flex; flex-direction: column; width: 1200px; height: 630px; padding: 56px 64px; background: #fafafa; color: #18181b; font-family: 'Noto Sans';"
>
	<div style="display: flex; flex-shrink: 0; justify-content: space-between; align-items: center;">
		<div style="display: flex; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">ClaimSale</div>
		<div
			style="display: flex; padding: 8px 20px; border-radius: 999px; font-size: 26px; font-weight: 700; background: {status.bg}; color: {status.fg};"
		>
			{SHARE_CARD_STATUS_LABELS[card.status]}
		</div>
	</div>
	<!-- Block, not flex, so a wrapped title takes the height of its lines; two lines at most.
	     Nothing above the item list shrinks, so a long title never runs into the seller line. -->
	<div
		style="display: block; flex-shrink: 0; overflow: hidden; margin-top: 32px; font-size: {card.title.length >
		50
			? 52
			: 64}px; font-weight: 700; line-height: 1.2; line-clamp: 2;"
	>
		{card.title}
	</div>
	<div style="display: flex; flex-shrink: 0; margin-top: 12px; font-size: 30px; color: #52525b;">
		{card.private ? `A private sale by ${card.seller}` : `${count} from ${card.seller}`}
	</div>
	{#if card.private}
		<div style="display: flex; margin-top: 48px; font-size: 28px; color: #52525b;">
			Only invited buyers can see the items.
		</div>
	{:else}
		<div style="display: flex; flex-direction: column; margin-top: 24px; overflow: hidden;">
			{#each card.items as item, i (i)}
				<div
					style="display: flex; justify-content: space-between; padding: 10px 0; border-top: 2px solid #e4e4e7; font-size: 30px; color: {item.soldOut
						? '#a1a1aa'
						: '#18181b'};"
				>
					<div style="display: flex;">{item.title}</div>
					<div style="display: flex; font-weight: 700;">{item.soldOut ? "Sold" : item.price}</div>
				</div>
			{/each}
			{#if card.more > 0}
				<div style="display: flex; padding-top: 10px; font-size: 26px; color: #52525b;">
					and {card.more} more
				</div>
			{/if}
		</div>
	{/if}
</div>
