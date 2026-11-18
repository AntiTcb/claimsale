<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import { INVOICE_STATUS_LABELS } from "#lib/invoice-labels.ts";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Your invoices · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-3xl px-4 py-10">
	<h1 class="text-2xl font-bold tracking-tight">Your invoices</h1>
	{#if data.invoices.length === 0}
		<p class="mt-6">No invoices yet. When you win an item, it shows up here.</p>
	{:else}
		<ul class="mt-6 flex flex-col gap-3">
			{#each data.invoices as invoice (invoice.id)}
				<li class="rounded-md border border-zinc-200 p-3 dark:border-zinc-800" data-testid="my-invoice">
					<a class="font-medium underline" href="/me/invoices/{invoice.id}">{invoice.saleTitle}</a>
					<p class="text-sm text-zinc-600 dark:text-zinc-400">
						{invoice.number} · @{invoice.sellerHandle ?? "seller"} · {invoice.lineCount}
						{invoice.lineCount === 1 ? "item" : "items"} · {formatCents(invoice.totalCents)} ·
						<span class={invoice.status === "overdue" ? "font-semibold text-red-700 dark:text-red-400" : ""}
							>{INVOICE_STATUS_LABELS[invoice.status]}</span
						>
					</p>
				</li>
			{/each}
		</ul>
	{/if}
</section>
