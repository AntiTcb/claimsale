<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import SiteFooter from "#lib/components/SiteFooter.svelte";
	import SiteHeader from "#lib/components/SiteHeader.svelte";

	let { children, data } = $props();

	// The root layout mounts last, after every component of the first page: from here on its
	// buttons have their handlers. E2E tests wait for this before clicking (waitForRouter).
	onMount(() => {
		document.documentElement.dataset["hydrated"] = "";
	});
</script>

<div class="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
	<SiteHeader user={data.user} unread={data.unreadNotifications} />
	<main class="flex-1">
		{@render children()}
	</main>
	<SiteFooter />
</div>
