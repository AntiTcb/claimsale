<script lang="ts">
	/** The new-sale wizard's progress: details → terms → items (PLAN §7). */
	interface Props {
		current: 1 | 2 | 3;
		/** Once the draft exists, finished steps link back to their page. */
		saleId?: string | null;
	}

	let { current, saleId = null }: Props = $props();

	const steps = $derived([
		{ n: 1, label: "Details", href: saleId ? `/sell/${saleId}` : "/sell/new" },
		{ n: 2, label: "Terms", href: saleId ? `/sell/${saleId}/terms?wizard=1` : null },
		{ n: 3, label: "Items", href: saleId ? `/sell/${saleId}/items?wizard=1` : null },
	]);
</script>

<nav aria-label="New sale steps">
	<ol class="flex gap-2 text-sm">
		{#each steps as step (step.n)}
			<li class="flex items-center gap-2">
				{#if step.n > 1}<span aria-hidden="true" class="text-zinc-400">→</span>{/if}
				{#if step.n === current}
					<span aria-current="step" class="font-semibold">{step.n}. {step.label}</span>
				{:else if step.href && step.n < current}
					<a href={step.href} class="underline">{step.n}. {step.label}</a>
				{:else}
					<span class="text-zinc-600 dark:text-zinc-400">{step.n}. {step.label}</span>
				{/if}
			</li>
		{/each}
	</ol>
</nav>
