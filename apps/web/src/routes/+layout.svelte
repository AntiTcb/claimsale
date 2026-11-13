<script lang="ts">
	import "../app.css";
	import SiteFooter from "#lib/components/SiteFooter.svelte";
	import SiteHeader from "#lib/components/SiteHeader.svelte";

	let { children, data } = $props();
</script>

<div class="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
	<SiteHeader user={data.user} />
	<main class="flex-1">
		{@render children()}
	</main>
	<SiteFooter />
</div>
