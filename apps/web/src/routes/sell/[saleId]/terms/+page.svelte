<script lang="ts">
	import { enhance } from "$app/forms";
	import TextField from "#lib/components/TextField.svelte";
	import WizardSteps from "#lib/components/WizardSteps.svelte";
	import { PAYMENT_METHODS, UNPROTECTED_METHODS } from "#lib/listing-input.ts";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const t = $derived(data.terms);
	const errors = $derived<Record<string, string>>(form && "errors" in form ? form.errors : {});
	const fieldClass =
		"rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<svelte:head>
	<title>Terms · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-xl px-4 py-8">
	{#if data.wizard}<WizardSteps current={2} saleId={data.sale.id} />{/if}
	<h1 class="mt-4 text-2xl font-bold tracking-tight">Terms</h1>
	{#if form && "saved" in form}
		<p
			role="status"
			class="mt-2 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200"
		>
			Saved.
		</p>
	{/if}
	<form
		method="POST"
		use:enhance={() =>
			({ update }) =>
				update({ reset: false })}
		class="mt-6 flex flex-col gap-6"
		novalidate
	>
		<fieldset
			class="flex flex-col gap-2"
			aria-describedby="pm-hint{errors['paymentMethods'] ? ' pm-error' : ''}"
		>
			<legend class="text-sm font-medium">Payment methods you accept</legend>
			{#each PAYMENT_METHODS as method (method.id)}
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						name="paymentMethods"
						value={method.id}
						checked={t.paymentMethods.includes(method.id)}
					/>
					{method.name}{#if UNPROTECTED_METHODS.has(method.id)}<span
							class="text-sm text-amber-900 dark:text-amber-200"
						>
							· no buyer protection</span
						>{/if}
				</label>
			{/each}
			<p id="pm-hint" class="text-sm text-zinc-600 dark:text-zinc-400">
				Payment happens off ClaimSale. Your handles go on invoices.
			</p>
			{#if errors["paymentMethods"]}<p id="pm-error" class="text-sm text-red-700 dark:text-red-400">
					{errors["paymentMethods"]}
				</p>{/if}
		</fieldset>

		<fieldset
			class="flex flex-col gap-2"
			aria-describedby={errors["paymentDeadlineHours"] ? "deadline-error" : undefined}
		>
			<legend class="text-sm font-medium">Payment deadline after the invoice is sent</legend>
			<label class="flex items-center gap-2">
				<input type="radio" name="paymentDeadlineHours" value="48" checked={t.paymentDeadlineHours === 48} /> 48
				hours
			</label>
			<label class="flex items-center gap-2">
				<input
					type="radio"
					name="paymentDeadlineHours"
					value="24"
					checked={t.paymentDeadlineHours === 24}
					disabled={data.tier !== "pro"}
				/>
				24 hours{#if data.tier !== "pro"}<span class="text-sm"> · Pro</span>{/if}
			</label>
			{#if errors["paymentDeadlineHours"]}
				<p id="deadline-error" class="text-sm text-red-700 dark:text-red-400">
					{errors["paymentDeadlineHours"]}
				</p>
			{/if}
		</fieldset>

		<fieldset class="flex flex-col gap-2">
			<legend class="text-sm font-medium">Offer amounts</legend>
			<label class="flex items-center gap-2">
				<input type="radio" name="offerVisibility" value="blind" checked={t.offerVisibility === "blind"} /> Only
				I see offer amounts
			</label>
			<label class="flex items-center gap-2">
				<input
					type="radio"
					name="offerVisibility"
					value="visible"
					checked={t.offerVisibility === "visible"}
				/> Everyone sees amounts (anonymously)
			</label>
		</fieldset>

		<div class="flex flex-col gap-2">
			<label class="flex items-center gap-2">
				<input type="checkbox" name="reviewEveryClaim" checked={t.reviewEveryClaim} /> Review every claim before
				it wins
			</label>
			<label class="flex items-center gap-2">
				<input type="checkbox" name="allowBackupOffers" checked={t.allowBackupOffers} /> Allow backup offers on
				sold-out items
			</label>
		</div>

		<div class="flex flex-col gap-1">
			<label for="field-decisionWindowHours" class="text-sm font-medium"
				>Decision window (hours){#if data.tier !== "pro"}<span class="font-normal"> · Pro</span>{/if}</label
			>
			<input
				id="field-decisionWindowHours"
				name="decisionWindowHours"
				inputmode="numeric"
				placeholder="24"
				value={t.decisionWindowHours ?? ""}
				disabled={data.tier !== "pro"}
				aria-describedby="window-hint{errors['decisionWindowHours'] ? ' window-error' : ''}"
				aria-invalid={errors["decisionWindowHours"] ? "true" : undefined}
				class="w-32 {fieldClass}"
			/>
			<p id="window-hint" class="text-sm text-zinc-600 dark:text-zinc-400">
				How long you have to pick between a full-price claim and offers before the earliest claim wins. Empty
				is 24 hours{data.tier !== "pro" ? ", which is fixed for free sellers" : ""}.
			</p>
			{#if errors["decisionWindowHours"]}<p id="window-error" class="text-sm text-red-700 dark:text-red-400">
					{errors["decisionWindowHours"]}
				</p>{/if}
		</div>

		<fieldset class="flex flex-col gap-2">
			<legend class="text-sm font-medium">Who can claim</legend>
			<label class="flex items-center gap-2">
				<input type="checkbox" name="requireVerifiedEmail" checked={t.requireVerifiedEmail} /> Buyers need a verified
				email
			</label>
			<label for="field-minAccountAgeDays" class="text-sm">Minimum account age (days)</label>
			<input
				id="field-minAccountAgeDays"
				name="minAccountAgeDays"
				inputmode="numeric"
				placeholder="0"
				value={t.minAccountAgeDays === 0 ? "" : t.minAccountAgeDays}
				aria-describedby="age-hint{errors['minAccountAgeDays'] ? ' age-error' : ''}"
				aria-invalid={errors["minAccountAgeDays"] ? "true" : undefined}
				class="w-32 {fieldClass}"
			/>
			<p id="age-hint" class="text-sm text-zinc-600 dark:text-zinc-400">
				Pro buyers skip both requirements. Empty allows new accounts.
			</p>
			{#if errors["minAccountAgeDays"]}<p id="age-error" class="text-sm text-red-700 dark:text-red-400">
					{errors["minAccountAgeDays"]}
				</p>{/if}
		</fieldset>

		<TextField label="Ships to" name="shipsTo" maxlength={200} value={t.shipsTo} error={errors["shipsTo"]} />

		<div class="flex flex-col gap-1">
			<label for="field-rulesMd" class="text-sm font-medium">Rules and shipping policy (optional)</label>
			<textarea
				id="field-rulesMd"
				name="rulesMd"
				rows="5"
				maxlength="5000"
				aria-invalid={errors["rulesMd"] ? "true" : undefined}
				class={fieldClass}>{t.rulesMd}</textarea
			>
			{#if errors["rulesMd"]}<p class="text-sm text-red-700 dark:text-red-400">{errors["rulesMd"]}</p>{/if}
		</div>

		<button
			type="submit"
			class="self-start rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>{data.wizard ? "Continue to items" : "Save terms"}</button
		>
	</form>
</section>
