<script lang="ts">
	import { enhance } from "$app/forms";
	import TextField from "#lib/components/TextField.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const empty = { name: "", line1: "", line2: "", city: "", region: "", postalCode: "" };
	const values = $derived(form?.action === "add" && "values" in form ? form.values : empty);
	const errors = $derived<Record<string, string>>(
		form?.action === "add" && "errors" in form ? form.errors : {},
	);
	const message = $derived(form && "message" in form ? form.message : null);
</script>

<svelte:head>
	<title>Addresses · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-10">
	<h1 class="text-2xl font-bold tracking-tight">Shipping addresses</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		You pick one when you pay an invoice. A seller sees it only on your invoices from them.
	</p>
	{#if message}<p role="alert" class="mt-4 text-red-700 dark:text-red-400">{message}</p>{/if}

	{#if data.addresses.length === 0}
		<p class="mt-6">No addresses yet.</p>
	{:else}
		<ul class="mt-6 flex flex-col gap-3">
			{#each data.addresses as address (address.id)}
				<li class="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
					<address class="not-italic">
						<span class="font-medium">{address.name}</span>{#if address.isDefault}<span
								class="ml-2 rounded-full bg-zinc-200 px-2 text-xs dark:bg-zinc-800">Default</span
							>{/if}<br />
						{address.line1}{#if address.line2}, {address.line2}{/if}<br />
						{address.city}, {address.region}
						{address.postalCode}
					</address>
					<div class="mt-2 flex gap-4 text-sm">
						{#if !address.isDefault}
							<form method="POST" action="?/makeDefault" use:enhance>
								<input type="hidden" name="id" value={address.id} />
								<button type="submit" class="underline"
									>Make default<span class="sr-only"> ({address.name}, {address.line1})</span></button
								>
							</form>
						{/if}
						<form method="POST" action="?/delete" use:enhance>
							<input type="hidden" name="id" value={address.id} />
							<button type="submit" class="text-red-700 underline dark:text-red-400"
								>Delete<span class="sr-only"> ({address.name}, {address.line1})</span></button
							>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Add an address</h2>
	{#if form?.action === "add" && "added" in form}<p
			role="status"
			class="mt-2 text-green-800 dark:text-green-300"
		>
			Address saved.
		</p>{/if}
	<form method="POST" action="?/add" use:enhance class="mt-4 flex flex-col gap-4" novalidate>
		<TextField
			label="Full name"
			name="name"
			autocomplete="name"
			required
			value={values.name}
			error={errors["name"]}
		/>
		<TextField
			label="Street address"
			name="line1"
			autocomplete="address-line1"
			required
			value={values.line1}
			error={errors["line1"]}
		/>
		<TextField
			label="Apartment, suite (optional)"
			name="line2"
			autocomplete="address-line2"
			value={values.line2}
			error={errors["line2"]}
		/>
		<TextField
			label="City"
			name="city"
			autocomplete="address-level2"
			required
			value={values.city}
			error={errors["city"]}
		/>
		<div class="grid grid-cols-2 gap-4">
			<TextField
				label="State"
				name="region"
				autocomplete="address-level1"
				required
				maxlength={2}
				value={values.region}
				error={errors["region"]}
			/>
			<TextField
				label="ZIP code"
				name="postalCode"
				autocomplete="postal-code"
				required
				maxlength={10}
				value={values.postalCode}
				error={errors["postalCode"]}
			/>
		</div>
		<label class="flex items-center gap-2"
			><input type="checkbox" name="isDefault" /> Make this my default address</label
		>
		<p class="text-sm text-zinc-600 dark:text-zinc-400">US addresses only for now.</p>
		<button
			type="submit"
			class="self-start rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>Save address</button
		>
	</form>
</section>
