<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import ItemCard from "#lib/components/ItemCard.svelte";
	import SaleCard from "#lib/components/SaleCard.svelte";
	import { gameName } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
	const r = $derived(data.results);
	const nothing = $derived(r.products.length + r.items.length + r.sales.length === 0);
	const input = "rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<svelte:head>
	<title>{data.q ? `${data.q} · ` : ""}Search · ClaimSale</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Search</h1>
	<form method="GET" role="search" class="mt-4 flex flex-wrap gap-2">
		<label class="sr-only" for="q">Search cards and sales</label>
		<input id="q" name="q" type="search" value={data.q} maxlength="120" class="{input} min-w-0 flex-1" />
		<label class="sr-only" for="game">Game</label>
		<select id="game" name="game" class={input}>
			<option value="">All games</option>
			{#each data.games as game (game.slug)}
				<option value={game.slug} selected={data.gameId === game.slug}>{game.name}</option>
			{/each}
		</select>
		<button
			type="submit"
			class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">Search</button
		>
	</form>

	{#if r.terms.length === 0}
		<p class="mt-6 text-zinc-600 dark:text-zinc-400">Type a card, product or sale name.</p>
	{:else if nothing}
		<p class="mt-6 text-zinc-600 dark:text-zinc-400">
			Nothing in live or upcoming public sales matches “{data.q}”.
		</p>
	{/if}

	{#if r.products.length > 0}
		<h2 class="mt-8 text-lg font-semibold">Who has this card?</h2>
		<ul class="mt-3 grid gap-2 sm:grid-cols-2" data-testid="product-results">
			{#each r.products as product (product.productId)}
				<li>
					<a
						href="/card/{product.productId}"
						class="flex flex-col rounded-lg border border-zinc-200 p-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
					>
						<span class="font-medium">{product.name}</span>
						<span class="text-sm text-zinc-600 dark:text-zinc-400"
							>{gameName(product.gameId)} · {product.setName}{product.number
								? ` · ${product.number}`
								: ""}</span
						>
						<span class="text-sm"
							>{product.listings}
							{product.listings === 1 ? "listing" : "listings"} from {formatCents(product.fromCents)}</span
						>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	{#if r.items.length > 0}
		<h2 class="mt-8 text-lg font-semibold">Items</h2>
		<ul class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="item-results">
			{#each r.items as item (item.id)}
				<li>
					<ItemCard
						href="/s/{item.saleSlug}/i/{item.id}"
						title={item.title}
						priceCents={item.priceCents}
						quantity={item.quantity - item.unitsWon}
						gameId={item.gameId}
						kind={item.kind}
						condition={item.condition}
						photoUrl={item.imageId ? `/api/images/${item.imageId}` : null}
						state={item.state as "available"}
						listedIn="{item.saleTitle}{item.sellerHandle ? ` · @${item.sellerHandle}` : ''}"
					/>
				</li>
			{/each}
		</ul>
	{/if}

	{#if r.sales.length > 0}
		<h2 class="mt-8 text-lg font-semibold">Sales</h2>
		<ul class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each r.sales as sale (sale.id)}<li><SaleCard {...sale} /></li>{/each}
		</ul>
	{/if}
</section>
