<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import { enhance } from "$app/forms";
	import InvoiceLines from "#lib/components/InvoiceLines.svelte";
	import TrackingNumber from "#lib/components/TrackingNumber.svelte";
	import { addressLines, INVOICE_STATUS_LABELS } from "#lib/invoice-labels.ts";
	import { PAYMENT_METHODS, UNPROTECTED_METHODS } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";
	import { useDates } from "#lib/time-zone.svelte.ts";

	let { data, form }: PageProps = $props();
	const dates = useDates();
	const invoice = $derived(data.invoice);
	const payable = $derived(invoice.status === "sent" || invoice.status === "overdue");
	const message = $derived(form && "message" in form ? form.message : null);
	const values = $derived(form && "values" in form ? form.values : null);
	const methodName = (id: string) => PAYMENT_METHODS.find((m) => m.id === id)?.name ?? id;
	const at = (ms: number | null) => (ms === null ? "" : dates(ms));
	const defaultAddress = $derived(data.addresses.find((a) => a.isDefault)?.id ?? data.addresses[0]?.id ?? "");
	const fieldClass =
		"rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";
	const button = "rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900";
</script>

<svelte:head>
	<title>Invoice {invoice.number} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-3xl px-4 py-10">
	<p class="text-sm"><a class="underline" href="/me/invoices">Your invoices</a></p>
	<h1 class="mt-2 text-2xl font-bold tracking-tight">Invoice {invoice.number}</h1>
	<p class="mt-1">
		<a class="underline" href="/s/{invoice.sale.slug}">{invoice.sale.title}</a> by @{invoice.seller.handle ??
			"seller"}
		· <span data-testid="invoice-status">{INVOICE_STATUS_LABELS[invoice.status]}</span>
	</p>
	{#if message}<p role="alert" class="mt-3 text-red-700 dark:text-red-400">{message}</p>{/if}

	<InvoiceLines {invoice} />

	{#if invoice.status === "draft"}
		<p class="mt-6">This is your running total. The seller sends the invoice after the sale closes.</p>
	{:else if payable}
		<div class="mt-8">
			<h2 class="text-lg font-semibold">Pay the seller</h2>
			{#if invoice.status === "overdue"}
				<p class="mt-2 font-medium text-red-700 dark:text-red-400">
					The payment deadline passed. Pay now and the seller can still accept it.
				</p>
			{:else if invoice.dueAt}
				<p class="mt-2">Pay by {at(invoice.dueAt)}.</p>
			{/if}
			<p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
				Payment happens off ClaimSale. Pay the total with shipping to one of these:
			</p>
			{#if invoice.seller.paymentHandles.length > 0}
				<ul class="mt-2 flex flex-col gap-1" data-testid="payment-handles">
					{#each invoice.seller.paymentHandles as handle (handle.kind)}
						<li>
							<span class="font-medium">{methodName(handle.kind)}:</span>
							{handle.value}{#if UNPROTECTED_METHODS.has(handle.kind)}<span
									class="text-sm text-amber-900 dark:text-amber-200"
								>
									· no buyer protection</span
								>{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-2">
					The seller accepts {invoice.paymentMethods.map(methodName).join(", ")}. Message them for their
					handle.
				</p>
			{/if}

			{#if invoice.shippingOptions.length === 0}
				<p class="mt-4" role="alert">
					The seller hasn't set up a shipping option for this order yet. Ask them to add one.
				</p>
			{:else if data.addresses.length === 0}
				<p class="mt-4">
					Add a <a class="underline" href="/me/addresses">shipping address</a> first, then come back to pay.
				</p>
			{:else}
				<form method="POST" action="?/pay" use:enhance class="mt-4 flex flex-col gap-4" novalidate>
					<fieldset class="flex flex-col gap-2">
						<legend class="text-sm font-medium">Shipping</legend>
						{#each invoice.shippingOptions as option, i (option.id)}
							<label class="flex items-center gap-2">
								<input
									type="radio"
									name="shippingOptionId"
									value={option.id}
									checked={values ? values.shippingOptionId === option.id : i === 0}
								/>
								{option.label} · {formatCents(option.priceCents)}{option.tracked ? " · tracked" : ""}
								· total {formatCents(invoice.subtotalCents + option.priceCents + invoice.adjustmentCents)}
							</label>
						{/each}
					</fieldset>
					<div class="flex flex-col gap-1">
						<label for="pay-address" class="text-sm font-medium">Ship to</label>
						<select id="pay-address" name="addressId" class={fieldClass}>
							{#each data.addresses as address (address.id)}
								<option value={address.id} selected={(values?.addressId ?? defaultAddress) === address.id}
									>{address.label}</option
								>
							{/each}
						</select>
						<a class="text-sm underline" href="/me/addresses">Manage addresses</a>
					</div>
					<div class="flex flex-col gap-1">
						<label for="pay-ref" class="text-sm font-medium">Payment reference (optional)</label>
						<input
							id="pay-ref"
							name="paymentRef"
							maxlength="200"
							value={values?.paymentRef ?? ""}
							class={fieldClass}
						/>
					</div>
					<button type="submit" class="self-start {button}">I've paid</button>
				</form>
			{/if}
		</div>
	{:else}
		<dl class="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
			{#if invoice.buyerPaidAt}<dt class="font-medium">You marked it paid</dt>
				<dd>{at(invoice.buyerPaidAt)}</dd>{/if}
			{#if invoice.paidAt}<dt class="font-medium">Seller confirmed payment</dt>
				<dd>{at(invoice.paidAt)}</dd>{/if}
			{#if invoice.shippedAt}<dt class="font-medium">Shipped</dt>
				<dd>{at(invoice.shippedAt)}</dd>{/if}
			{#if invoice.tracking}<dt class="font-medium">Tracking</dt>
				<dd data-testid="tracking">
					<TrackingNumber carrier={invoice.tracking.carrier} number={invoice.tracking.number} />
				</dd>{/if}
		</dl>
		{#if invoice.address}
			<h2 class="mt-6 text-lg font-semibold">Shipping to</h2>
			<address class="mt-2 not-italic">
				{#each addressLines(invoice.address) as line, i (i)}{line}<br />{/each}
			</address>
		{/if}
		{#if invoice.status === "buyer_paid"}
			<p class="mt-6">Waiting for the seller to confirm your payment.</p>
		{:else if invoice.status === "paid"}
			<p class="mt-6">Paid. The seller ships next.</p>
		{:else if invoice.status === "shipped"}
			<form method="POST" action="?/received" use:enhance class="mt-6">
				<p>Got your order? Let the seller know. It completes on its own 14 days after shipping.</p>
				<button type="submit" class="mt-3 {button}">I received it</button>
			</form>
		{:else if invoice.status === "completed"}
			<p class="mt-6" role="status">Completed. Thanks for confirming!</p>
		{/if}
	{/if}
</section>
