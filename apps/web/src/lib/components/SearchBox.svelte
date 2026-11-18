<script lang="ts">
	/** The site search form: a plain GET to /search, so it works before hydration. */
	interface Props {
		value?: string;
		/** Keeps the search within one game. */
		game?: string | null;
	}

	let { value = "", game = null }: Props = $props();
</script>

<form method="GET" action="/search" role="search" class="flex gap-2">
	<label class="sr-only" for="site-search">Search cards and sales</label>
	<input
		id="site-search"
		name="q"
		type="search"
		{value}
		maxlength="120"
		placeholder="Search cards and sales, e.g. Charizard ex"
		class="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
	/>
	{#if game}<input type="hidden" name="game" value={game} />{/if}
	<button
		type="submit"
		class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">Search</button
	>
</form>
