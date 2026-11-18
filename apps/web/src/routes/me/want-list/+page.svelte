<script lang="ts">
	import { enhance } from "$app/forms";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
	const select = "rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<svelte:head>
	<title>Want list · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-10">
	<h1 class="text-2xl font-bold tracking-tight">Want list</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		We'll tell you when one of these is listed in a public sale at your price or less.
	</p>

	{#if data.wants.length === 0}
		<p class="mt-6">Nothing on your want list yet.</p>
	{:else}
		<ul class="mt-6 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800" aria-label="Your want list">
			{#each data.wants as want (want.id)}
				<li class="flex items-start justify-between gap-3 py-3">
					<span>
						<span class="block font-medium">{want.name}</span>
						<span class="block text-sm text-zinc-600 dark:text-zinc-300"
							>{want.setName}{#if want.number}
								· {want.number}{/if}</span
						>
						<span class="block text-sm text-zinc-600 dark:text-zinc-300">
							{[
								want.finishLabel,
								want.languageLabel,
								want.minCondition ? `${want.minCondition} or better` : null,
								want.maxPriceCents !== null ? `up to ${dollars(want.maxPriceCents)}` : "any price",
							]
								.filter(Boolean)
								.join(" · ")}
						</span>
					</span>
					<form method="POST" action="?/remove" use:enhance>
						<input type="hidden" name="id" value={want.id} />
						<button type="submit" class="text-sm text-red-700 underline dark:text-red-400"
							>Remove<span class="sr-only"> {want.name}</span></button
						>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Add a card</h2>
	{#if form?.action === "add" && "added" in form}
		<p role="status" class="mt-2 text-green-800 dark:text-green-300">Added to your want list.</p>
	{/if}
	<form method="GET" class="mt-3 flex gap-2" role="search">
		<label for="want-search" class="sr-only">Search the catalog</label>
		<input
			id="want-search"
			name="q"
			type="search"
			value={data.query}
			placeholder="Card or product name"
			class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
		/>
		<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1.5">Search</button>
	</form>
	{#if data.searchUnavailable}
		<p role="alert" class="mt-3 text-red-700 dark:text-red-400">
			Search is unavailable right now. Try again soon.
		</p>
	{:else if data.query.trim().length >= 2 && data.hits.length === 0}
		<p class="mt-3">No cards match “{data.query}”.</p>
	{/if}
	<ul class="mt-4 flex flex-col gap-4">
		{#each data.hits as hit (hit.productId)}
			<li class="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
				<p class="font-medium">{hit.name}</p>
				<p class="text-sm text-zinc-600 dark:text-zinc-300">
					{hit.game} · {hit.setName}{#if hit.number}
						· {hit.number}{/if}
				</p>
				{#if form?.action === "add" && "message" in form && form.productId === String(hit.productId)}
					<p role="alert" class="mt-2 text-sm text-red-700 dark:text-red-400">{form.message}</p>
				{/if}
				<form method="POST" action="?/add" use:enhance class="mt-2 grid grid-cols-2 gap-2 text-sm">
					<input type="hidden" name="productId" value={hit.productId} />
					<label class="flex flex-col gap-1">
						Finish
						<select name="finish" class={select}>
							<option value="">Any</option>
							{#each hit.finishes as finish (finish.id)}<option value={finish.id}>{finish.label}</option
								>{/each}
						</select>
					</label>
					<label class="flex flex-col gap-1">
						Language
						<select name="language" class={select}>
							<option value="">Any</option>
							{#each hit.languages as language (language.id)}<option value={language.id}
									>{language.label}</option
								>{/each}
						</select>
					</label>
					<label class="flex flex-col gap-1">
						Minimum condition
						<select name="minCondition" class={select}>
							<option value="">Any</option>
							{#each data.conditions as condition (condition.id)}<option value={condition.id}
									>{condition.label}</option
								>{/each}
						</select>
					</label>
					<label class="flex flex-col gap-1">
						Max price ($)
						<input name="maxPrice" inputmode="decimal" placeholder="Any" class={select} />
					</label>
					<button
						type="submit"
						class="col-span-2 justify-self-start rounded-md bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900"
						>Add to want list<span class="sr-only"> ({hit.name}, {hit.setName})</span></button
					>
				</form>
			</li>
		{/each}
	</ul>
</section>
