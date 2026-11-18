<script lang="ts">
	import { enhance } from "$app/forms";
	import NotificationList from "#lib/components/NotificationList.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const unread = $derived(data.notifications.filter((n) => !n.read).length);
</script>

<svelte:head>
	<title>Notifications · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-10">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-2xl font-bold tracking-tight">Notifications</h1>
		{#if unread > 0}
			<form method="POST" action="?/readAll" use:enhance>
				<button type="submit" class="text-sm underline">Mark all as read</button>
			</form>
		{/if}
	</div>
	{#if form?.action === "open" && "message" in form}
		<p role="alert" class="mt-4 text-red-700 dark:text-red-400">{form.message}</p>
	{/if}
	<NotificationList notifications={data.notifications} />

	<p class="mt-8 text-sm">
		<a href="/me/messages" class="underline">Messages</a> ·
		<a href="/me/want-list" class="underline">Want list</a>
	</p>

	<h2 class="mt-10 text-lg font-semibold">Email</h2>
	<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
		Everything shows here. Choose what we also email you.
		{#if !data.emailVerified}<strong>Confirm your email address to get any email.</strong>{/if}
	</p>
	{#if form?.action === "preferences" && "saved" in form}
		<p role="status" class="mt-2 text-green-800 dark:text-green-300">Email preferences saved.</p>
	{/if}
	<form method="POST" action="?/preferences" use:enhance class="mt-4 flex flex-col gap-3">
		<fieldset class="flex flex-col gap-3">
			<legend class="sr-only">Email me about</legend>
			{#each data.categories as category (category.id)}
				<label class="flex items-start gap-2">
					<input type="checkbox" name="email" value={category.id} checked={category.email} class="mt-1" />
					<span>
						<span class="block font-medium">{category.label}</span>
						<span class="block text-sm text-zinc-600 dark:text-zinc-300">{category.hint}</span>
					</span>
				</label>
			{/each}
		</fieldset>
		<button
			type="submit"
			class="self-start rounded-md bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>Save email preferences</button
		>
	</form>
</section>
