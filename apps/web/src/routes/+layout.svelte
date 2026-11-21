<script lang="ts">
	import "../app.css";
	import { onMount } from "svelte";
	import SiteFooter from "#lib/components/SiteFooter.svelte";
	import SiteHeader from "#lib/components/SiteHeader.svelte";
	import { provideTimeZone } from "#lib/time-zone.svelte.ts";

	let { children, data } = $props();
	const timeZone = provideTimeZone(() => data.timeZone);

	// The root layout mounts last, after every component of the first page: from here on its
	// buttons have their handlers. E2E tests wait for this before clicking (waitForRouter).
	onMount(() => {
		// Dates switch to the browser's own time zone (and the cookie remembers it for the server).
		timeZone.mounted();
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
