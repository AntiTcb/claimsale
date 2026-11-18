<script lang="ts">
	interface Props {
		/** Unread notifications (the layout loads it on every navigation). */
		unread: number;
	}

	let { unread }: Props = $props();
	const shown = $derived(unread > 99 ? "99+" : String(unread));
	const label = $derived(unread === 0 ? "Notifications" : `Notifications, ${unread} unread`);
</script>

<a
	href="/me/notifications"
	class="relative inline-flex items-center rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
	aria-label={label}
	title={label}
>
	<svg
		aria-hidden="true"
		viewBox="0 0 24 24"
		class="size-5"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
		<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
	</svg>
	{#if unread > 0}
		<span
			data-testid="unread-count"
			aria-hidden="true"
			class="absolute -top-1 -right-1 min-w-4 rounded-full bg-red-700 px-1 text-center text-[10px] leading-4 font-semibold text-white"
			>{shown}</span
		>
	{/if}
</a>
