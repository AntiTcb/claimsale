<script lang="ts">
	interface Props {
		user: { handle: string | null; displayName: string } | null;
	}

	let { user }: Props = $props();
</script>

<header class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
	<nav class="mx-auto flex max-w-4xl items-center justify-between gap-4" aria-label="Main">
		<a href="/" class="font-bold tracking-tight">ClaimSale</a>
		{#if user}
			<div class="flex items-center gap-4 text-sm">
				{#if user.handle}
					<a href="/u/{user.handle}" class="hover:underline">@{user.handle}</a>
				{/if}
				<a href="/me/settings" class="hover:underline">Settings</a>
				<form method="POST" action="/logout">
					<button type="submit" class="hover:underline">Sign out</button>
				</form>
			</div>
		{:else}
			<div class="flex items-center gap-4 text-sm">
				<a href="/login" class="hover:underline">Sign in</a>
				<a
					href="/signup"
					class="rounded-md bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900"
				>
					Create account
				</a>
			</div>
		{/if}
	</nav>
</header>
