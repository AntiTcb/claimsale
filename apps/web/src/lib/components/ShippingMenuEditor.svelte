<script lang="ts">
	import { SHIPPING_MENU_MAX, type ShippingMenuError, type Tier } from "@claimsale/core";
	import { tick } from "svelte";

	/**
	 * The shipping menu rows of the sale's shipping form (D15). It renders form fields
	 * (`optionId`, `optionLabel`, `optionPrice`, `optionTracked` = the row's index), so the
	 * page's form posts them; core's `validateShippingMenu` checks them on the server.
	 */
	interface Option {
		readonly id: string;
		readonly label: string;
		/** Dollars as typed, e.g. "1.50". */
		readonly price: string;
		readonly tracked: boolean;
	}

	interface Props {
		options: readonly Option[];
		errors?: readonly ShippingMenuError[];
		tier: Tier;
		/** The rows are suggestions the seller hasn't saved yet. */
		suggested?: boolean;
	}

	let { options, errors = [], tier, suggested = false }: Props = $props();

	interface Row extends Option {
		readonly key: number;
		id: string;
		label: string;
		price: string;
		tracked: boolean;
	}

	let nextKey = 0;
	// Seeded once from the props; the page re-creates the editor (`{#key}`) to reset it.
	// svelte-ignore state_referenced_locally
	let rows = $state<Row[]>(options.map((o) => ({ ...o, key: nextKey++ })));

	const rowError = (index: number, field: "label" | "price") =>
		errors.find((e) => e.row === index && e.field === field)?.message;
	const menuError = $derived(errors.find((e) => e.row === -1)?.message);

	async function addRow() {
		const key = nextKey++;
		rows.push({ key, id: "", label: "", price: "", tracked: false });
		await tick();
		document.getElementById(`option-label-${key}`)?.focus();
	}

	async function removeRow(key: number) {
		rows = rows.filter((r) => r.key !== key);
		await tick();
		document.getElementById("add-shipping-option")?.focus();
	}

	const fieldClass =
		"w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<fieldset class="flex flex-col gap-3" aria-describedby="menu-hint{menuError ? ' menu-error' : ''}">
	<legend class="text-lg font-semibold">Shipping options</legend>
	<p id="menu-hint" class="text-sm text-zinc-600 dark:text-zinc-400">
		One flat price per invoice; the buyer picks one when paying. Untracked options are hidden once an invoice
		is over {tier === "pro" ? "$40" : "$20"}, and for graded or sealed items.
		{#if suggested}These are suggestions until you save.{/if}
	</p>
	{#if menuError}<p id="menu-error" class="text-sm text-red-700 dark:text-red-400">{menuError}</p>{/if}
	<ul class="flex flex-col gap-3">
		{#each rows as row, index (row.key)}
			{@const labelError = rowError(index, "label")}
			{@const priceError = rowError(index, "price")}
			<li
				class="grid grid-cols-[1fr_7rem] gap-2 rounded-md border border-zinc-200 p-3 sm:grid-cols-[1fr_7rem_auto_auto] dark:border-zinc-800"
				data-testid="shipping-option"
			>
				<input type="hidden" name="optionId" value={row.id} />
				<div class="flex flex-col gap-1">
					<label for="option-label-{row.key}" class="text-sm font-medium">Option {index + 1} name</label>
					<input
						id="option-label-{row.key}"
						name="optionLabel"
						maxlength="60"
						bind:value={row.label}
						aria-invalid={labelError ? "true" : undefined}
						aria-describedby={labelError ? `option-label-${row.key}-error` : undefined}
						class={fieldClass}
					/>
					{#if labelError}<p id="option-label-{row.key}-error" class="text-sm text-red-700 dark:text-red-400">
							{labelError}
						</p>{/if}
				</div>
				<div class="flex flex-col gap-1">
					<label for="option-price-{row.key}" class="text-sm font-medium"
						>Price ($){" "}<span class="sr-only">for option {index + 1}</span></label
					>
					<input
						id="option-price-{row.key}"
						name="optionPrice"
						inputmode="decimal"
						bind:value={row.price}
						aria-invalid={priceError ? "true" : undefined}
						aria-describedby={priceError ? `option-price-${row.key}-error` : undefined}
						class={fieldClass}
					/>
					{#if priceError}<p id="option-price-{row.key}-error" class="text-sm text-red-700 dark:text-red-400">
							{priceError}
						</p>{/if}
				</div>
				<label class="flex items-center gap-2 self-end pb-2">
					<input type="checkbox" name="optionTracked" value={String(index)} bind:checked={row.tracked} />
					Tracked{" "}<span class="sr-only">(option {index + 1})</span>
				</label>
				<button
					type="button"
					class="self-end pb-2 text-sm text-red-700 underline dark:text-red-400"
					onclick={() => removeRow(row.key)}
					>Remove{" "}<span class="sr-only">option {index + 1}</span></button
				>
			</li>
		{/each}
	</ul>
	{#if rows.length < SHIPPING_MENU_MAX}
		<button id="add-shipping-option" type="button" class="self-start text-sm underline" onclick={addRow}
			>Add an option</button
		>
	{/if}
</fieldset>
