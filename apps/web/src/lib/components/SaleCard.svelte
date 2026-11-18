<script lang="ts">
	import type { SaleStatus } from "@claimsale/core";
	import SaleStatusBadge from "./SaleStatusBadge.svelte";

	/** One sale in browse lists and on the landing page (WS-L). */
	interface Props {
		slug: string;
		title: string;
		status: SaleStatus;
		liveAt: number | null;
		sellerHandle: string | null;
		sellerName: string;
		itemCount: number;
		imageId: string | null;
	}

	let { slug, title, status, liveAt, sellerHandle, sellerName, itemCount, imageId }: Props = $props();
</script>

<article class="flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
	<a href="/s/{slug}" class="flex min-w-0 flex-1 items-center gap-3 p-2">
		{#if imageId}
			<img
				src="/api/images/{imageId}"
				alt=""
				class="size-16 shrink-0 rounded bg-zinc-100 object-cover dark:bg-zinc-900"
				loading="lazy"
			/>
		{:else}
			<div class="size-16 shrink-0 rounded bg-zinc-100 dark:bg-zinc-900"></div>
		{/if}
		<div class="flex min-w-0 flex-col gap-1">
			<h3 class="truncate font-medium">{title}</h3>
			<p class="truncate text-sm text-zinc-600 dark:text-zinc-400">
				{sellerHandle ? `@${sellerHandle}` : sellerName} · {itemCount}
				{itemCount === 1 ? "item" : "items"}
			</p>
			<p><SaleStatusBadge {status} {liveAt} /></p>
		</div>
	</a>
</article>
