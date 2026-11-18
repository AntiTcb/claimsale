<script lang="ts">
	import SaleCard from "#lib/components/SaleCard.svelte";
	import SearchBox from "#lib/components/SearchBox.svelte";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Browse claim sales · ClaimSale</title>
	<meta name="description" content="Live and upcoming public claim sales for trading card games." />
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Browse</h1>
	<div class="mt-4"><SearchBox /></div>

	<h2 class="mt-8 text-lg font-semibold">Games</h2>
	<ul class="mt-3 flex flex-wrap gap-2">
		{#each data.games as game (game.slug)}
			<li>
				<a
					href="/g/{game.slug}"
					class="inline-flex items-center gap-2 rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>{game.name}<span class="text-zinc-600 dark:text-zinc-400">{game.items}</span></a
				>
			</li>
		{/each}
	</ul>

	<h2 class="mt-8 text-lg font-semibold">Live now</h2>
	{#if data.live.length === 0}
		<p class="mt-2 text-zinc-600 dark:text-zinc-400">No public sales are live right now.</p>
	{:else}
		<ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.live as sale (sale.id)}<li><SaleCard {...sale} /></li>{/each}
		</ul>
	{/if}

	<h2 class="mt-8 text-lg font-semibold">Going live soon</h2>
	{#if data.upcoming.length === 0}
		<p class="mt-2 text-zinc-600 dark:text-zinc-400">No public sales are scheduled yet.</p>
	{:else}
		<ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.upcoming as sale (sale.id)}<li><SaleCard {...sale} /></li>{/each}
		</ul>
	{/if}
</section>
