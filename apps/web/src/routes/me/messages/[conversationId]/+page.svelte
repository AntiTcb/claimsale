<script lang="ts">
	import { enhance } from "$app/forms";
	import MessageComposer from "#lib/components/MessageComposer.svelte";
	import MessageThread from "#lib/components/MessageThread.svelte";
	import { watchConversation } from "#lib/messaging/live.ts";
	import { parseThreadMessage, type ThreadMessage } from "#lib/messaging/thread.ts";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const conversation = $derived(data.conversation);
	let live = $state<ThreadMessage[]>([]);
	const messages = $derived([
		...conversation.messages,
		...live.filter((m) => !conversation.messages.some((s) => s.id === m.id)),
	]);
	const other = $derived(conversation.side === "buyer" ? conversation.seller : conversation.buyer);
	const cannotSend = $derived(conversation.side === "buyer" && conversation.blocked);

	// New messages from the other side arrive through the conversation feed (see live.ts for the
	// WebSocket seam). Restarted whenever the server data changes (after a send or a reload).
	$effect(() => {
		const id = conversation.id;
		const newest = conversation.messages.at(-1)?.createdAt ?? 0;
		live = [];
		const feed = watchConversation<ThreadMessage>(id, newest, (fresh) => (live = [...live, ...fresh]), {
			parse: parseThreadMessage,
		});
		return () => feed.stop();
	});
</script>

<svelte:head>
	<title>Messages with {other.displayName} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-10">
	<p class="text-sm"><a href="/me/messages" class="underline">All messages</a></p>
	<h1 class="mt-2 text-2xl font-bold tracking-tight">
		{other.displayName}
		{#if other.handle}<a href="/u/{other.handle}" class="text-base font-normal underline">@{other.handle}</a
			>{/if}
	</h1>
	<p class="text-zinc-600 dark:text-zinc-300">
		About <a href="/s/{conversation.sale.slug}" class="underline">{conversation.sale.title}</a>
	</p>

	{#if form && "error" in form && form.action !== "send"}
		<p role="alert" class="mt-4 text-red-700 dark:text-red-400">{form.error}</p>
	{/if}
	{#if form?.action === "report" && "reported" in form}
		<p role="status" class="mt-4 text-green-800 dark:text-green-300">
			Thanks. An admin will review the report.
		</p>
	{/if}

	<div class="mt-6">
		<MessageThread {messages} />
		<span id="latest"></span>
	</div>

	<div class="mt-6">
		{#if cannotSend}
			<p role="status" class="text-zinc-600 dark:text-zinc-300">
				The seller isn't accepting messages from you.
			</p>
		{:else}
			<MessageComposer
				action="?/send"
				label="Message {other.displayName}"
				error={form?.action === "send" && "error" in form ? form.error : undefined}
				value={form?.action === "send" && "body" in form ? form.body : ""}
			/>
		{/if}
	</div>

	{#if conversation.side === "seller"}
		<div class="mt-8 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
			{#if conversation.blocked}
				<p>You blocked {other.displayName}. They can't message you or claim in your sales.</p>
				<form method="POST" action="?/unblock" use:enhance class="mt-2">
					<button type="submit" class="underline">Unblock {other.displayName}</button>
				</form>
			{:else}
				<form method="POST" action="?/block" use:enhance>
					<button type="submit" class="text-red-700 underline dark:text-red-400"
						>Block {other.displayName}</button
					>
				</form>
				<p class="mt-1 text-zinc-600 dark:text-zinc-400">
					They won't be able to message you or claim in your sales.
				</p>
			{/if}
		</div>
	{/if}
</section>
