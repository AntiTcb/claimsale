<script lang="ts">
	import ItemCard from "#lib/components/ItemCard.svelte";
	import { gameName } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
	const p = $derived(data.product);
	const details = $derived(
		[gameName(p.gameId), p.setName, p.number, p.rarity ?? p.productType].filter(Boolean).join(" · "),
	);
</script>

<svelte:head>
	<title>Who has {p.name}? · ClaimSale</title>
	<meta name="description" content="{p.name} ({p.setName}) in live and upcoming claim sales." />
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<p class="text-sm"><a href="/g/{p.gameId}" class="underline">{gameName(p.gameId)}</a></p>
	<h1 class="mt-1 text-2xl font-bold tracking-tight">Who has {p.name}?</h1>
	<p class="mt-1 text-zinc-600 dark:text-zinc-400">{details}</p>

	{#if data.listings.length === 0}
		<p class="mt-6">No live or upcoming public sale has this one right now.</p>
	{:else}
		<p class="mt-4">
			{data.listings.length}
			{data.listings.length === 1 ? "listing" : "listings"} in live and upcoming public sales, cheapest first.
		</p>
		<ul class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="who-has">
			{#each data.listings as item (item.id)}
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
	<p class="mt-6 text-sm">
		{#if data.signedIn}
			Want to hear when a new one is listed? Add it to <a href="/me/want-list" class="underline"
				>your want list</a
			>.
		{:else}
			<a href="/login" class="underline">Sign in</a> to add it to your want list and hear when a new one is listed.
		{/if}
	</p>
</section>
