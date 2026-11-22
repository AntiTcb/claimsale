<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import { enhance } from "$app/forms";
	import { INVOICE_STATUS_LABELS } from "#lib/invoice-labels.ts";
	import type { PageProps } from "./$types";
	import { useDates } from "#lib/time-zone.svelte.ts";

	let { data, form }: PageProps = $props();
	const dates = useDates();
	const closed = $derived(data.sale.status === "closed" || data.sale.status === "archived");
	const drafts = $derived(
		data.buyers.reduce((n, b) => n + b.invoices.filter((i) => i.status === "draft").length, 0),
	);
	const due = (at: number | null) => (at === null ? "" : dates(at));
</script>

<svelte:head>
	<title>Buyers · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Buyers</h1>
	{#if form && "message" in form}<p role="alert" class="mt-2 text-red-700 dark:text-red-400">
			{form.message}
		</p>{/if}
	{#if form && "sent" in form}<p role="status" class="mt-2 text-green-800 dark:text-green-300">
			Sent {form.sent}
			{form.sent === 1 ? "invoice" : "invoices"}.
		</p>{/if}
	{#if form && "closed" in form}<p role="status" class="mt-2 text-green-800 dark:text-green-300">
			The sale is closed. Review the invoices, then send them.
		</p>{/if}

	{#if data.sale.status === "live"}
		<p class="mt-4">Invoices go out after the sale closes. Buyers see their running total until then.</p>
		<form method="POST" action="?/close" use:enhance class="mt-3">
			<button type="submit" class="rounded-md border border-zinc-300 px-4 py-2 dark:border-zinc-700"
				>Close the sale now</button
			>
		</form>
	{:else if closed && drafts > 0}
		<form method="POST" action="?/sendAll" use:enhance class="mt-4 flex flex-wrap items-center gap-3">
			<button
				type="submit"
				class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
				>Send all {drafts} {drafts === 1 ? "invoice" : "invoices"}</button
			>
			<span class="text-sm text-zinc-600 dark:text-zinc-400">Buyers get a payment deadline from now.</span>
		</form>
	{/if}

	{#if data.buyers.length === 0}
		<p class="mt-6">No buyers yet. Wins show up here as they happen.</p>
	{:else}
		<div class="mt-6 overflow-x-auto">
			<table class="w-full text-left text-sm">
				<caption class="sr-only">Buyers and their invoices</caption>
				<thead class="border-b border-zinc-200 dark:border-zinc-800">
					<tr>
						<th scope="col" class="py-2 pr-4">Buyer</th>
						<th scope="col" class="py-2 pr-4">Invoice</th>
						<th scope="col" class="py-2 pr-4">Items</th>
						<th scope="col" class="py-2 pr-4">Total</th>
						<th scope="col" class="py-2 pr-4">Status</th>
						<th scope="col" class="py-2">Due</th>
					</tr>
				</thead>
				<tbody>
					{#each data.buyers as row (row.buyer.id)}
						{#each row.invoices as invoice, i (invoice.id)}
							<tr class="border-b border-zinc-100 dark:border-zinc-900" data-testid="buyer-invoice">
								<td class="py-2 pr-4">
									{#if i === 0}<span class="font-medium">@{row.buyer.handle ?? "unknown"}</span>
										<span class="text-zinc-600 dark:text-zinc-400">{row.buyer.displayName}</span>{/if}
								</td>
								<td class="py-2 pr-4">
									<a class="underline" href="/sell/{data.sale.id}/invoices/{invoice.id}"
										>{invoice.number}{" "}<span class="sr-only">for @{row.buyer.handle}</span></a
									>
								</td>
								<td class="py-2 pr-4">{invoice.lineCount}</td>
								<td class="py-2 pr-4">{formatCents(invoice.totalCents)}</td>
								<td class="py-2 pr-4">{INVOICE_STATUS_LABELS[invoice.status]}</td>
								<td class="py-2"
									>{invoice.status === "sent" || invoice.status === "overdue" ? due(invoice.dueAt) : ""}</td
								>
							</tr>
						{/each}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
