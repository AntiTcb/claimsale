<script lang="ts">
	import type { SellerBlocker } from "@claimsale/core";

	interface Props {
		/** From `sellerReadiness()`: what's missing, in order. */
		blockers: readonly SellerBlocker[];
	}

	let { blockers }: Props = $props();

	const steps = $derived([
		{
			key: "age" as const,
			label: "You're 18 or older",
			fix: "Selling is for adults. You told us you're under 18 when you signed up.",
			href: undefined,
		},
		{
			key: "email" as const,
			label: "Verified email",
			fix: "Open the link we emailed you, or send a new one.",
			href: "/me/settings",
		},
	]);
</script>

<section aria-labelledby="seller-requirements-title" class="flex flex-col gap-3">
	<h2 id="seller-requirements-title" class="text-lg font-semibold">
		{blockers.length === 0 ? "You're ready to sell" : "Before you can sell"}
	</h2>
	<ul class="flex flex-col gap-2">
		{#each steps as step (step.key)}
			{@const done = !blockers.includes(step.key)}
			<li class="flex items-start gap-2" data-done={done}>
				<span aria-hidden="true" class={done ? "text-green-700 dark:text-green-400" : "text-zinc-500"}
					>{done ? "✓" : "○"}</span
				>
				<div>
					<p>
						{step.label}<span class="sr-only">: {done ? "done" : "missing"}</span>
					</p>
					{#if !done}
						<p class="text-sm text-zinc-600 dark:text-zinc-300">
							{step.fix}
							{#if step.href}<a href={step.href} class="underline">Go to settings</a>{/if}
						</p>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
</section>
