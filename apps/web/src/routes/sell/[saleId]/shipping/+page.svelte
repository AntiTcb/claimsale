<script lang="ts">
	import { enhance } from "$app/forms";
	import ShippingMenuEditor from "#lib/components/ShippingMenuEditor.svelte";
	import { PAYMENT_METHODS } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();

	/** Bumped after a save, so the editor re-reads the saved menu (with the new options' IDs). */
	let saves = $state(0);
	// Without JavaScript, a failed save renders the posted rows again.
	const options = $derived(
		form && "options" in form
			? form.options
			: data.settings.menu.map((o) => ({
					id: o.id,
					label: o.label,
					price: (o.priceCents / 100).toFixed(2),
					tracked: o.tracked,
				})),
	);
	const handles = $derived<Record<string, string>>(
		form && "handles" in form
			? form.handles
			: Object.fromEntries(data.settings.paymentHandles.map((h) => [h.kind, h.value])),
	);
	const menuErrors = $derived(form && "errors" in form ? form.errors.menu : []);
	const handleErrors = $derived<Record<string, string>>(form && "errors" in form ? form.errors.handles : {});

	const fieldClass =
		"w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<svelte:head>
	<title>Shipping and payment · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-2xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Shipping and payment</h1>
	{#if form && "saved" in form}
		<p
			role="status"
			class="mt-2 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200"
		>
			Saved.
		</p>
	{/if}
	{#if form && "message" in form}<p role="alert" class="mt-2 text-red-700 dark:text-red-400">
			{form.message}
		</p>{/if}

	<form
		method="POST"
		use:enhance={() =>
			async ({ update, result }) => {
				await update({ reset: false });
				// New options got their IDs on save: take them, so the next save keeps them.
				if (result.type === "success") saves++;
			}}
		class="mt-6 flex flex-col gap-8"
		novalidate
	>
		{#key saves}
			<ShippingMenuEditor
				{options}
				errors={menuErrors}
				tier={data.tier}
				suggested={data.settings.suggested}
			/>
		{/key}

		<fieldset class="flex flex-col gap-2">
			<legend class="text-lg font-semibold">Invoices</legend>
			<label class="flex items-center gap-2">
				<input type="checkbox" name="autoSendAtClose" checked={data.settings.autoSendAtClose} /> Send every invoice
				automatically when the sale closes
			</label>
			<label class="flex items-center gap-2">
				<input type="checkbox" name="autoRescindOverdue" checked={data.settings.autoRescindOverdue} /> When a payment
				is overdue, rescind it and pass the items to the next backup automatically
			</label>
		</fieldset>

		<fieldset class="flex flex-col gap-3">
			<legend class="text-lg font-semibold">Your payment handles</legend>
			<p class="text-sm text-zinc-600 dark:text-zinc-400">
				Shown to buyers on their invoices, for every sale of yours. Payment happens off ClaimSale.
			</p>
			{#each PAYMENT_METHODS as method (method.id)}
				{@const error = handleErrors[method.id]}
				<div class="flex flex-col gap-1">
					<label for="handle-{method.id}" class="text-sm font-medium">{method.name}</label>
					<input
						id="handle-{method.id}"
						name="handle_{method.id}"
						maxlength="100"
						value={handles[method.id] ?? ""}
						aria-invalid={error ? "true" : undefined}
						class={fieldClass}
					/>
					{#if error}<p class="text-sm text-red-700 dark:text-red-400">{error}</p>{/if}
				</div>
			{/each}
		</fieldset>

		<button
			type="submit"
			class="self-start rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>Save shipping and payment</button
		>
	</form>
</section>
