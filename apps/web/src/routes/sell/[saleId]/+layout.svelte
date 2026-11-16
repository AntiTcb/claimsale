<script lang="ts">
	import { page } from "$app/state";
	import SaleStatusBadge from "#lib/components/SaleStatusBadge.svelte";
	import type { LayoutProps } from "./$types";

	let { data, children }: LayoutProps = $props();
	const base = $derived(`/sell/${data.sale.id}`);
	const tabs = $derived([
		{ href: base, label: "Overview" },
		{ href: `${base}/terms`, label: "Terms" },
		{ href: `${base}/items`, label: "Items" },
	]);
</script>

<div class="mx-auto max-w-5xl px-4 pt-8">
	<p class="text-sm"><a href="/sell" class="underline">Your sales</a></p>
	<div class="mt-2 flex flex-wrap items-center gap-3">
		<p class="text-xl font-semibold">{data.sale.title}</p>
		<SaleStatusBadge status={data.sale.status} liveAt={data.sale.liveAt} />
		{#if data.sale.status !== "draft"}
			<a href="/s/{data.sale.slug}" class="text-sm underline">View sale page</a>
		{:else}
			<a href="/s/{data.sale.slug}" class="text-sm underline">Preview (only you can see it)</a>
		{/if}
	</div>
	<nav aria-label="Sale sections" class="mt-4 border-b border-zinc-200 dark:border-zinc-800">
		<ul class="flex gap-4 text-sm">
			{#each tabs as tab (tab.href)}
				{@const current = page.url.pathname === tab.href}
				<li>
					<a
						href={tab.href}
						aria-current={current ? "page" : undefined}
						class="inline-block border-b-2 pb-2 {current
							? 'border-zinc-900 font-semibold dark:border-zinc-100'
							: 'border-transparent'}">{tab.label}</a
					>
				</li>
			{/each}
		</ul>
	</nav>
</div>
{@render children()}
