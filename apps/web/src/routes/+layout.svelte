<script lang="ts">
	import "../app.css";
	import SiteFooter from "#lib/components/SiteFooter.svelte";

	let { children } = $props();
</script>

<div class="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
	<main class="flex-1">
		{@render children()}
	</main>
	<SiteFooter />
</div>
