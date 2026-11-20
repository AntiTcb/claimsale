<script lang="ts">
	import SellerRequirements from "#lib/components/SellerRequirements.svelte";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Start selling · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-md px-4 py-12">
	<h1 class="text-2xl font-bold tracking-tight">Start selling</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		To keep sales safe, every seller confirms a few things first.
	</p>
	<div class="mt-6">
		<SellerRequirements blockers={data.blockers} />
	</div>
	{#if data.blockers.length === 0}
		<a
			href={data.next}
			class="mt-6 inline-block rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>Continue</a
		>
	{/if}
</section>
