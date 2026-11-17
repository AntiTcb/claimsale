<script lang="ts">
	import MessageComposer from "#lib/components/MessageComposer.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Message the seller · {data.header.title} · ClaimSale</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-10">
	<p class="text-sm"><a href="/s/{data.header.slug}" class="underline">Back to the sale</a></p>
	<h1 class="mt-2 text-2xl font-bold tracking-tight">Message {data.header.sellerDisplayName}</h1>
	<p class="mt-1 text-zinc-600 dark:text-zinc-300">About {data.header.title}</p>
	<p class="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
		Asking a question doesn't claim anything. Pay only through the seller's invoice.
	</p>
	<div class="mt-6">
		{#if data.blocked}
			<p role="status">The seller isn't accepting messages from you.</p>
		{:else}
			<MessageComposer action="?/send" error={form?.error} value={form?.body ?? ""} />
		{/if}
	</div>
</section>
