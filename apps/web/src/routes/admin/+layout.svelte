<script lang="ts">
	import { page } from "$app/state";
	import type { LayoutProps } from "./$types";

	let { children }: LayoutProps = $props();
	const tabs = [
		{ href: "/admin", label: "Photos and flags" },
		{ href: "/admin/rescinds", label: "Rescinds" },
		{ href: "/admin/reports", label: "Reports" },
		{ href: "/admin/users", label: "Users" },
	];
</script>

<nav
	aria-label="Admin sections"
	class="mx-auto max-w-5xl border-b border-zinc-200 px-4 pt-6 dark:border-zinc-800"
>
	<ul class="flex flex-wrap gap-4 text-sm">
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
{@render children()}
