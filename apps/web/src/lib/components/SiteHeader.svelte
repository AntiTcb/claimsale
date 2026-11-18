<script lang="ts">
	import NotificationBell from "./NotificationBell.svelte";

	interface Props {
		user: { handle: string | null; displayName: string } | null;
		/** Unread notifications for the bell (WS-K). */
		unread?: number;
	}

	let { user, unread = 0 }: Props = $props();
</script>

<header class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
	<!-- Wraps instead of overflowing: handles are up to 20 characters and phones start at 320px. -->
	<nav
		class="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-4 gap-y-2"
		aria-label="Main"
	>
		<a href="/" class="font-bold tracking-tight">ClaimSale</a>
		{#if user}
			<div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
				<a href="/browse" class="hover:underline">Browse</a>
				{#if user.handle}
					<a href="/u/{user.handle}" class="max-w-40 truncate hover:underline">@{user.handle}</a>
				{/if}
				<a href="/me/invoices" class="hover:underline">Invoices</a>
				<a href="/sell" class="hover:underline">Sell</a>
				<a href="/me/messages" class="hover:underline">Messages</a>
				<a href="/me/settings" class="hover:underline">Settings</a>
				<NotificationBell {unread} />
				<form method="POST" action="/logout">
					<button type="submit" class="hover:underline">Sign out</button>
				</form>
			</div>
		{:else}
			<div class="flex items-center gap-4 text-sm">
				<a href="/browse" class="hover:underline">Browse</a>
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
