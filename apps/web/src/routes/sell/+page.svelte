<script lang="ts">
	import SaleStatusBadge from "#lib/components/SaleStatusBadge.svelte";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Your sales · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-3xl px-4 py-10">
	<div class="flex items-center justify-between gap-4">
		<h1 class="text-2xl font-bold tracking-tight">Your sales</h1>
		<a
			href="/sell/new"
			class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">New sale</a
		>
	</div>
	{#if data.tier === "free"}
		<p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
			Free plan: {data.active} of {data.caps.sales} sales scheduled or live, up to {data.caps.items} items each.
		</p>
	{/if}

	{#if data.sales.length === 0}
		<p class="mt-8">No sales yet. Start one: add your items and photos, then schedule when it goes live.</p>
	{:else}
		<ul class="mt-6 divide-y divide-zinc-200 dark:divide-zinc-800">
			{#each data.sales as sale (sale.id)}
				<li class="flex flex-wrap items-center justify-between gap-2 py-3">
					<div class="flex flex-col">
						<a href="/sell/{sale.id}" class="font-medium underline">{sale.title}</a>
						<span class="text-sm text-zinc-600 dark:text-zinc-400">
							{sale.itemCount} item{sale.itemCount === 1 ? "" : "s"} · {sale.visibility}
						</span>
					</div>
					<div class="flex items-center gap-3">
						<SaleStatusBadge status={sale.status} liveAt={sale.liveAt} />
						<a href="/sell/{sale.id}/items" class="text-sm underline"
							>Items<span class="sr-only"> of {sale.title}</span></a
						>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
