<script lang="ts">
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
	const since = $derived(
		new Date(data.profile.memberSince).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
	);
</script>

<svelte:head>
	<title>{data.profile.displayName} (@{data.profile.handle}) · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-2xl px-4 py-12">
	<div class="flex items-center gap-4">
		{#if data.profile.avatarUrl}
			<img src={data.profile.avatarUrl} alt="" class="size-16 rounded-full" />
		{:else}
			<div
				aria-hidden="true"
				class="flex size-16 items-center justify-center rounded-full bg-zinc-200 text-2xl font-semibold dark:bg-zinc-800"
			>
				{data.profile.displayName.slice(0, 1).toUpperCase()}
			</div>
		{/if}
		<div>
			<h1 class="text-2xl font-bold tracking-tight">{data.profile.displayName}</h1>
			<p class="text-zinc-600 dark:text-zinc-300">@{data.profile.handle} · member since {since}</p>
		</div>
	</div>
	{#if data.profile.fbProfileUrl}
		<p class="mt-6">
			<a href={data.profile.fbProfileUrl} rel="nofollow noopener noreferrer" target="_blank" class="underline"
				>Facebook profile</a
			>
			<span class="text-sm text-zinc-600 dark:text-zinc-400">(added by the user, not verified)</span>
		</p>
	{/if}
	<p class="mt-8 text-zinc-600 dark:text-zinc-300">Sales and feedback will show here.</p>
</section>
