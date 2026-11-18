<script lang="ts">
	import {
		BROWSE_KINDS,
		CONDITION_LABELS,
		FINISH_LABELS,
		ITEM_SORT_LABELS,
		ITEM_SORTS,
		LANGUAGE_LABELS,
	} from "@claimsale/core";
	import ItemCard from "#lib/components/ItemCard.svelte";
	import SearchBox from "#lib/components/SearchBox.svelte";
	import { kindName } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
	const f = $derived(data.filters);
	const label = (labels: Record<string, string>, value: string) => labels[value] ?? value;
	const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
	const input = "rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<svelte:head>
	<title>{data.game.name} claim sales · ClaimSale</title>
	<meta
		name="description"
		content="{data.game.name} singles, graded cards and sealed product in live claim sales."
	/>
</svelte:head>

<section class="mx-auto max-w-6xl px-4 py-8">
	<p class="text-sm"><a href="/browse" class="underline">Browse</a></p>
	<h1 class="mt-1 text-2xl font-bold tracking-tight">{data.game.name}</h1>
	<div class="mt-4"><SearchBox game={data.game.slug} /></div>

	<div class="mt-6 grid gap-6 md:grid-cols-[14rem_1fr]">
		<form method="GET" class="flex flex-col gap-4 text-sm" aria-label="Filters">
			<label class="flex flex-col gap-1"
				>Sort
				<select name="sort" class={input}>
					{#each ITEM_SORTS as sort (sort)}
						<option value={sort} selected={f.sort === sort}>{ITEM_SORT_LABELS[sort]}</option>
					{/each}
				</select>
			</label>
			<label class="flex flex-col gap-1"
				>Kind
				<select name="kind" class={input}>
					<option value="">Any</option>
					{#each BROWSE_KINDS as kind (kind)}
						<option value={kind} selected={f.kind === kind}>{kindName(kind)}</option>
					{/each}
				</select>
			</label>
			<fieldset class="flex flex-col gap-1">
				<legend>Condition</legend>
				{#each data.game.conditionScale as condition (condition)}
					<label class="flex items-center gap-2"
						><input
							type="checkbox"
							name="condition"
							value={condition}
							checked={f.conditions.includes(condition)}
						/>{CONDITION_LABELS[condition]}</label
					>
				{/each}
			</fieldset>
			{#each [{ name: "set", label: "Set", values: data.facets.sets, labels: {} }, { name: "rarity", label: "Rarity", values: data.facets.rarities, labels: {} }, { name: "language", label: "Language", values: data.facets.languages, labels: LANGUAGE_LABELS }, { name: "finish", label: "Finish", values: data.facets.finishes, labels: FINISH_LABELS }] as facet (facet.name)}
				{#if facet.values.length > 0}
					{@const current = f[facet.name as "set" | "rarity" | "language" | "finish"]}
					<label class="flex flex-col gap-1"
						>{facet.label}
						<select name={facet.name} class={input}>
							<option value="">Any</option>
							{#each facet.values as value (value)}
								<option {value} selected={current === value}>{label(facet.labels, value)}</option>
							{/each}
						</select>
					</label>
				{/if}
			{/each}
			<fieldset class="flex gap-2">
				<legend class="mb-1">Price ($)</legend>
				<label class="flex flex-col gap-1"
					><span class="sr-only">Minimum price</span><input
						name="min"
						inputmode="decimal"
						placeholder="Min"
						value={dollars(f.minCents)}
						class="{input} w-full"
					/></label
				>
				<label class="flex flex-col gap-1"
					><span class="sr-only">Maximum price</span><input
						name="max"
						inputmode="decimal"
						placeholder="Max"
						value={dollars(f.maxCents)}
						class="{input} w-full"
					/></label
				>
			</fieldset>
			<div class="flex items-center gap-3">
				<button
					type="submit"
					class="rounded-md bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900"
					>Apply</button
				>
				<a href="/g/{data.game.slug}" class="underline">Clear</a>
			</div>
		</form>

		<div>
			{#if data.items.length === 0}
				<p class="text-zinc-600 dark:text-zinc-400">
					No {data.game.name} listings match. Live and upcoming public sales show here.
				</p>
			{:else}
				<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="game-items">
					{#each data.items as item (item.id)}
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
			{#if data.prev || data.next}
				<nav class="mt-6 flex justify-between text-sm" aria-label="Pages">
					{#if data.prev}<a href={data.prev} class="underline" rel="prev">Previous</a>{:else}<span
						></span>{/if}
					{#if data.next}<a href={data.next} class="underline" rel="next">Next</a>{/if}
				</nav>
			{/if}
		</div>
	</div>
</section>
