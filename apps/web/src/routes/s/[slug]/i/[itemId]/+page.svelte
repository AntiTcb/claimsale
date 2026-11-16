<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import { describeItem } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
	const item = $derived(data.item);
	const attributes = $derived(Object.entries(item.attributes));
	const STATE_LABELS: Record<string, string> = {
		deciding: "The seller is deciding between claims and offers.",
		sold_out: "Sold out.",
		withdrawn: "Withdrawn by the seller.",
		unsold: "Unsold.",
	};
</script>

<svelte:head>
	<title>{item.title} · {data.header.title} · ClaimSale</title>
	{#if !data.header.indexable}<meta name="robots" content="noindex, nofollow" />{/if}
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<p class="text-sm"><a href="/s/{data.header.slug}" class="underline">← {data.header.title}</a></p>
	<div class="mt-4 grid gap-8 md:grid-cols-2">
		<div class="flex flex-col gap-3">
			{#if data.photos.length === 0}
				<div class="flex aspect-square items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-900">
					No photo yet
				</div>
			{/if}
			{#each data.photos as photo, index (photo.id)}
				<img
					src={photo.url}
					alt="Photo {index + 1} of {data.photos.length}: {item.title}"
					width={photo.width ?? undefined}
					height={photo.height ?? undefined}
					class="w-full rounded-lg bg-zinc-100 object-contain dark:bg-zinc-900"
					loading={index === 0 ? "eager" : "lazy"}
				/>
			{/each}
		</div>
		<div>
			<h1 class="text-2xl font-bold tracking-tight">{item.title}</h1>
			<p class="mt-1 text-zinc-600 dark:text-zinc-300">
				{describeItem(item.gameId, item.kind, item.condition)}
			</p>
			<p class="mt-4 text-3xl font-semibold">{formatCents(item.priceCents)}</p>
			{#if item.quantity > 1}<p class="text-sm">{item.quantity} available</p>{/if}
			{#if STATE_LABELS[item.state]}<p class="mt-2 font-medium">{STATE_LABELS[item.state]}</p>{/if}
			{#if data.header.status === "scheduled" && data.body.liveAt}
				<p class="mt-4 rounded-md bg-sky-50 p-3 text-sky-950 dark:bg-sky-950 dark:text-sky-100" role="status">
					Claims open {new Date(data.body.liveAt).toLocaleString(undefined, {
						dateStyle: "full",
						timeStyle: "short",
					})}.
				</p>
			{/if}
			{#if item.descriptionMd}<p class="mt-4 whitespace-pre-line">{item.descriptionMd}</p>{/if}
			{#if attributes.length > 0}
				<dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
					{#each attributes as [key, value] (key)}
						<dt class="font-medium">{key}</dt>
						<dd>{String(value)}</dd>
					{/each}
				</dl>
			{/if}
		</div>
	</div>
</section>
