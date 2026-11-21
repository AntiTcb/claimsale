<script lang="ts">
	import type { PageProps } from "./$types";
	import { useDates } from "#lib/time-zone.svelte.ts";

	let { data }: PageProps = $props();
	const dates = useDates();
	const when = (at: number | null) => (at === null ? "" : dates(at, "short"));
</script>

<svelte:head>
	<title>Messages · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-10">
	<h1 class="text-2xl font-bold tracking-tight">Messages</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		One conversation per sale with each seller or buyer. To ask a seller something, use “Message the seller”
		on their sale.
	</p>
	{#if data.conversations.length === 0}
		<p class="mt-6">No messages yet.</p>
	{:else}
		<ul class="mt-6 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
			{#each data.conversations as conversation (conversation.id)}
				<li class="py-3">
					<a href="/me/messages/{conversation.id}" class="flex flex-col hover:underline">
						<span class="font-medium">
							{#if conversation.unread}<span class="sr-only">Unread: </span><span
									aria-hidden="true"
									class="mr-1 inline-block size-2 rounded-full bg-blue-700"
								></span>{/if}
							{conversation.otherName}
							<span class="text-sm font-normal text-zinc-600 dark:text-zinc-400"
								>({conversation.side === "buyer" ? "seller" : "buyer"})</span
							>
						</span>
						<span class="text-sm text-zinc-600 dark:text-zinc-300">{conversation.saleTitle}</span>
						<span class="text-xs text-zinc-500 dark:text-zinc-400">{when(conversation.lastMessageAt)}</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</section>
