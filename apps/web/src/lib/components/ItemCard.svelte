<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import { describeItem } from "#lib/listing-input.ts";

	/** One item in a sale's read-only grid (/s/[slug]). Claim buttons come with the live grid (WS-H). */
	interface Props {
		href: string;
		title: string;
		priceCents: number;
		quantity: number;
		gameId: string;
		kind: string;
		condition: string | null;
		photoUrl: string | null;
		/** Cached derived state (STATE_MACHINES §3). */
		state: "available" | "deciding" | "sold_out" | "withdrawn" | "unsold";
	}

	let { href, title, priceCents, quantity, gameId, kind, condition, photoUrl, state }: Props = $props();

	const STATE_LABELS: Record<Props["state"], string | null> = {
		available: null,
		deciding: "Seller deciding",
		sold_out: "Sold out",
		withdrawn: "Withdrawn",
		unsold: "Unsold",
	};
</script>

<article class="flex flex-col overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
	<a {href} class="flex flex-1 flex-col">
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
		<div class="flex flex-1 flex-col gap-1 p-3">
			<h3 class="font-medium leading-snug">{title}</h3>
			<p class="text-sm text-zinc-600 dark:text-zinc-400">
				{describeItem(gameId, kind, condition)}
			</p>
			<p class="mt-auto flex items-baseline justify-between pt-1">
				<span class="text-lg font-semibold">{formatCents(priceCents)}</span>
				{#if quantity > 1}<span class="text-sm text-zinc-600 dark:text-zinc-400">{quantity} available</span
					>{/if}
			</p>
			{#if STATE_LABELS[state]}
				<p class="text-sm font-medium">{STATE_LABELS[state]}</p>
			{/if}
		</div>
	</a>
</article>
