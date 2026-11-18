<script lang="ts">
	import { enhance } from "$app/forms";
	import ReportButton from "#lib/components/ReportButton.svelte";
	import SaleCard from "#lib/components/SaleCard.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
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
	<div class="mt-6 flex flex-wrap items-center gap-3">
		<span class="text-sm text-zinc-600 dark:text-zinc-300"
			>{data.follow.followers}
			{data.follow.followers === 1 ? "follower" : "followers"}</span
		>
		{#if !data.follow.signedIn}
			<a href="/login?next={encodeURIComponent(`/u/${data.profile.handle}`)}" class="text-sm underline"
				>Sign in to follow</a
			>
		{:else if !data.follow.self}
			{#if data.follow.following}
				<form method="POST" action="?/unfollow" use:enhance>
					<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1.5 text-sm"
						>Unfollow<span class="sr-only"> {data.profile.displayName}</span></button
					>
				</form>
			{:else}
				<form method="POST" action="?/follow" use:enhance>
					<button
						type="submit"
						class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
						>Follow<span class="sr-only"> {data.profile.displayName}</span></button
					>
				</form>
			{/if}
		{/if}
	</div>
	{#if form && "following" in form}
		<p role="status" class="mt-2 text-sm text-green-800 dark:text-green-300">
			{form.following
				? "Following. We'll tell you when they schedule or open a public sale."
				: "You unfollowed them."}
		</p>
	{:else if form && "message" in form}
		<p role="alert" class="mt-2 text-sm text-red-700 dark:text-red-400">{form.message}</p>
	{/if}
	<h2 class="mt-8 text-lg font-semibold">Public sales</h2>
	{#if data.sales.length === 0}
		<p class="mt-2 text-zinc-600 dark:text-zinc-300">No public sale is live or scheduled right now.</p>
	{:else}
		<ul class="mt-3 flex flex-col gap-3">
			{#each data.sales as sale (sale.id)}<li><SaleCard {...sale} /></li>{/each}
		</ul>
	{/if}
	{#if !data.follow.self}
		<div class="mt-8">
			<ReportButton
				kind="user"
				what="@{data.profile.handle}"
				signedIn={data.signedIn}
				next="/u/{data.profile.handle}"
				result={form && ("reported" in form || "reportError" in form) ? form : null}
			/>
		</div>
	{/if}
</section>
