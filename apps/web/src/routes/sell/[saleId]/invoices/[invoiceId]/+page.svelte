<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import { enhance } from "$app/forms";
	import InvoiceLines from "#lib/components/InvoiceLines.svelte";
	import TrackingNumber from "#lib/components/TrackingNumber.svelte";
	import { addressLines, CARRIER_CHOICES, INVOICE_STATUS_LABELS } from "#lib/invoice-labels.ts";
	import type { PageProps } from "./$types";
	import { useDates } from "#lib/time-zone.svelte.ts";

	let { data, form }: PageProps = $props();
	const dates = useDates();
	const invoice = $derived(data.invoice);
	const closed = $derived(data.sale.status === "closed" || data.sale.status === "archived");
	const at = (ms: number | null) => (ms === null ? "" : dates(ms));
	const message = $derived(form && "message" in form ? form.message : null);
	const fieldClass =
		"rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";
	const button = "rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900";
	const secondary = "rounded-md border border-zinc-300 px-4 py-2 dark:border-zinc-700";
</script>

<svelte:head>
	<title>Invoice {invoice.number} · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-3xl px-4 py-8">
	<p class="text-sm"><a class="underline" href="/sell/{data.sale.id}/buyers">All buyers</a></p>
	<h1 class="mt-2 text-2xl font-bold tracking-tight">Invoice {invoice.number}</h1>
	<p class="mt-1">
		For <span class="font-medium">@{invoice.buyer.handle ?? "unknown"}</span>
		<span class="text-zinc-600 dark:text-zinc-400">({invoice.buyer.displayName})</span>
		· <span data-testid="invoice-status">{INVOICE_STATUS_LABELS[invoice.status]}</span>
	</p>
	{#if message}<p role="alert" class="mt-3 text-red-700 dark:text-red-400">{message}</p>{/if}
	{#if form && "done" in form}<p role="status" class="mt-3 text-green-800 dark:text-green-300">Done.</p>{/if}

	<InvoiceLines {invoice} />

	<dl class="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
		{#if invoice.sentAt}<dt class="font-medium">Sent</dt>
			<dd>{at(invoice.sentAt)}</dd>{/if}
		{#if invoice.dueAt && (invoice.status === "sent" || invoice.status === "overdue")}<dt class="font-medium">
				Payment due
			</dt>
			<dd>{at(invoice.dueAt)}</dd>{/if}
		{#if invoice.buyerPaidAt}<dt class="font-medium">Buyer marked paid</dt>
			<dd>{at(invoice.buyerPaidAt)}</dd>{/if}
		{#if invoice.paymentRef}<dt class="font-medium">Payment reference</dt>
			<dd>{invoice.paymentRef}</dd>{/if}
		{#if invoice.shippedAt}<dt class="font-medium">Shipped</dt>
			<dd>{at(invoice.shippedAt)}</dd>{/if}
		{#if invoice.tracking}<dt class="font-medium">Tracking</dt>
			<dd data-testid="tracking">
				<TrackingNumber carrier={invoice.tracking.carrier} number={invoice.tracking.number} />
			</dd>{/if}
		{#if invoice.completedAt}<dt class="font-medium">Completed</dt>
			<dd>{at(invoice.completedAt)}</dd>{/if}
	</dl>

	{#if invoice.address}
		<h2 class="mt-6 text-lg font-semibold">Ship to</h2>
		<address class="mt-2 not-italic" data-testid="ship-to">
			{#each addressLines(invoice.address) as line, i (i)}{line}<br />{/each}
		</address>
	{/if}

	<div class="mt-8 flex flex-col gap-6">
		{#if invoice.status === "draft"}
			{#if closed}
				<form method="POST" action="?/send" use:enhance>
					<button type="submit" class={button}>Send invoice</button>
				</form>
			{:else}
				<p>You can send invoices once the sale closes. The buyer sees a running total until then.</p>
			{/if}
		{:else if invoice.status === "buyer_paid"}
			<p>Check that the payment of {formatCents(invoice.totalCents)} arrived, then confirm it.</p>
			<div class="flex flex-wrap gap-3">
				<form method="POST" action="?/confirm" use:enhance>
					<button type="submit" class={button}>Confirm payment received</button>
				</form>
				<form method="POST" action="?/notReceived" use:enhance>
					<button type="submit" class={secondary}>Payment not received</button>
				</form>
			</div>
		{:else if invoice.status === "paid"}
			<form method="POST" action="?/ship" use:enhance class="flex flex-col gap-3" novalidate>
				<h2 class="text-lg font-semibold">Mark as shipped</h2>
				<p class="text-sm text-zinc-600 dark:text-zinc-400">
					{invoice.trackingRequired
						? "This order needs a tracking number."
						: "Tracking is optional for this order."} Leave the carrier blank to detect it from the number.
				</p>
				<div class="flex flex-col gap-1">
					<label for="ship-carrier" class="text-sm font-medium">Carrier</label>
					<input id="ship-carrier" name="carrier" list="carriers" class={fieldClass} />
				</div>
				<div class="flex flex-col gap-1">
					<label for="ship-number" class="text-sm font-medium"
						>Tracking number{invoice.trackingRequired ? "" : " (optional)"}</label
					>
					<input
						id="ship-number"
						name="trackingNumber"
						class={fieldClass}
						required={invoice.trackingRequired}
					/>
				</div>
				<button type="submit" class="self-start {button}">Mark shipped</button>
			</form>
		{:else if invoice.status === "shipped"}
			<form method="POST" action="?/replaceTracking" use:enhance class="flex flex-col gap-3" novalidate>
				<h2 class="text-lg font-semibold">Correct the tracking</h2>
				<div class="flex flex-col gap-1">
					<label for="replace-carrier" class="text-sm font-medium">Carrier</label>
					<input id="replace-carrier" name="carrier" list="carriers" class={fieldClass} />
				</div>
				<div class="flex flex-col gap-1">
					<label for="replace-number" class="text-sm font-medium">New tracking number</label>
					<input id="replace-number" name="trackingNumber" class={fieldClass} />
				</div>
				<label class="flex items-center gap-2">
					<input type="checkbox" name="confirm" /> Replace {invoice.tracking
						? `tracking ${invoice.tracking.number}`
						: "the missing tracking"} (the change is logged)
				</label>
				<button type="submit" class="self-start {secondary}">Replace tracking</button>
			</form>
		{:else if invoice.status === "overdue"}
			<div class="flex flex-col gap-3">
				<p>
					The payment deadline passed. You can still accept a late payment, or pass every item to its next
					backup.
				</p>
				<form method="POST" action="?/rescindOverdue" use:enhance>
					<button type="submit" class="rounded-md bg-red-700 px-4 py-2 text-white"
						>Rescind and pass to next</button
					>
				</form>
			</div>
		{:else if invoice.status === "completed"}
			<p>Completed.</p>
		{/if}
	</div>
	<datalist id="carriers">
		{#each CARRIER_CHOICES as carrier (carrier)}<option value={carrier}></option>{/each}
	</datalist>
</section>
