<script lang="ts">
	import SaleCard from "#lib/components/SaleCard.svelte";
	import SaleStatusBadge from "#lib/components/SaleStatusBadge.svelte";
	import SearchBox from "#lib/components/SearchBox.svelte";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>ClaimSale — claim sales for trading card games</title>
	<meta
		name="description"
		content="Run and join claim sales for Yu-Gi-Oh, Pokémon, Magic: The Gathering, Riftbound and more."
	/>
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-10">
	<h1 class="text-3xl font-bold tracking-tight">ClaimSale</h1>
	<p class="mt-3 max-w-2xl text-lg text-zinc-600 dark:text-zinc-300">
		Claim sales for trading card games, without the comment-thread chaos. The first claim wins, backups move
		up on their own, and invoices are made for you when the sale closes.
	</p>
	<div class="mt-6 max-w-2xl"><SearchBox /></div>
	<ul class="mt-4 flex flex-wrap gap-2 text-sm">
		{#each data.games as game (game.slug)}
			<li>
				<a
					href="/g/{game.slug}"
					class="inline-block rounded-full border border-zinc-300 px-3 py-1 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
					>{game.name}</a
				>
			</li>
		{/each}
	</ul>

	{#if data.mySales.length > 0}
		<h2 class="mt-10 text-lg font-semibold">Your sales</h2>
		<ul class="mt-3 flex flex-col gap-2">
			{#each data.mySales as sale (sale.id)}
				<li class="flex flex-wrap items-center gap-3">
					<a href="/sell/{sale.id}" class="font-medium underline">{sale.title}</a>
					<SaleStatusBadge status={sale.status} liveAt={sale.liveAt} />
				</li>
			{/each}
		</ul>
		<p class="mt-2 text-sm"><a href="/sell" class="underline">All your sales</a></p>
	{/if}

	{#if data.follows > 0}
		<h2 class="mt-10 text-lg font-semibold">Sellers you follow</h2>
		{#if data.followedSales.length === 0}
			<p class="mt-2 text-zinc-600 dark:text-zinc-400">
				None of them has a public sale live or scheduled. We'll tell you when one does.
			</p>
		{:else}
			<ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="followed-sales">
				{#each data.followedSales as sale (sale.id)}<li><SaleCard {...sale} /></li>{/each}
			</ul>
		{/if}
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Live now</h2>
	{#if data.live.length === 0}
		<p class="mt-2 text-zinc-600 dark:text-zinc-400">No public sales are live right now.</p>
	{:else}
		<ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.live as sale (sale.id)}<li><SaleCard {...sale} /></li>{/each}
		</ul>
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Going live soon</h2>
	{#if data.upcoming.length === 0}
		<p class="mt-2 text-zinc-600 dark:text-zinc-400">No public sales are scheduled yet.</p>
	{:else}
		<ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.upcoming as sale (sale.id)}<li><SaleCard {...sale} /></li>{/each}
		</ul>
	{/if}
	<p class="mt-6"><a href="/browse" class="underline">Browse all sales</a></p>
</section>
