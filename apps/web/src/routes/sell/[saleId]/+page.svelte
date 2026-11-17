<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import SaleDetailsFields from "#lib/components/SaleDetailsFields.svelte";
	import TimestampPhoto from "#lib/components/TimestampPhoto.svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();

	const sale = $derived(data.sale);
	const detailsValues = $derived(
		form?.action === "details" && "values" in form
			? form.values
			: {
					title: sale.title,
					description: sale.descriptionMd,
					visibility: sale.visibility,
					allowlist: data.allowlist,
				},
	);
	const detailsErrors = $derived<Record<string, string>>(
		form?.action === "details" && "errors" in form ? form.errors : {},
	);
	const publishValues = $derived(
		form?.action === "publish" && "values" in form
			? form.values
			: { when: "schedule", liveAt: "", duration: "3" },
	);
	const message = $derived(form && "message" in form ? form.message : null);
	const editable = $derived(sale.status === "draft" || sale.status === "scheduled" || sale.status === "live");

	// The browser's offset, so a datetime-local value means the seller's local time.
	let tzOffset = $state(0);
	$effect(() => {
		tzOffset = new Date().getTimezoneOffset();
	});
	// svelte-ignore state_referenced_locally
	let when = $state(publishValues.when);
	const fmt = (ms: number | null) =>
		ms === null ? "" : new Date(ms).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
</script>

<svelte:head>
	<title>{sale.title} · Your sales · ClaimSale</title>
</svelte:head>

<section class="mx-auto grid max-w-5xl gap-10 px-4 py-8 md:grid-cols-2">
	<div>
		<h1 class="text-lg font-semibold">Publishing</h1>
		{#if message}
			<p role="alert" class="mt-3 rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
				{message}
			</p>
		{/if}

		{#if sale.status === "draft"}
			<ul class="mt-3 list-inside list-disc text-sm">
				<li>
					{data.itemCount} item{data.itemCount === 1 ? "" : "s"}{#if data.tier === "free"}
						(free plan: up to {data.caps.items}){/if}
				</li>
				{#if data.missingPhotos > 0}
					<li>{data.missingPhotos} item{data.missingPhotos === 1 ? " needs" : "s need"} a photo</li>
				{/if}
				{#if data.checkingPhotos > 0}
					<li>
						Photos of {data.checkingPhotos} item{data.checkingPhotos === 1 ? " are" : "s are"} being checked (<a
							href="?"
							class="underline"
							data-sveltekit-reload>refresh</a
						>)
					</li>
				{/if}
				{#if data.heldPhotos > 0}
					<li>Photos of {data.heldPhotos} item{data.heldPhotos === 1 ? " are" : "s are"} held for review</li>
				{/if}
				{#if data.tier === "free"}
					<li>{data.activeOtherSales} of {data.caps.sales} sales already scheduled or live</li>
				{/if}
			</ul>
			<form method="POST" action="?/publish" use:enhance class="mt-4 flex flex-col gap-4">
				<input type="hidden" name="tzOffset" value={tzOffset} />
				<fieldset class="flex flex-col gap-2">
					<legend class="text-sm font-medium">When does it go live?</legend>
					<label class="flex items-center gap-2"
						><input type="radio" name="when" value="schedule" bind:group={when} /> Schedule it (preview opens now)</label
					>
					<label class="flex items-center gap-2"
						><input type="radio" name="when" value="now" bind:group={when} /> Go live now</label
					>
				</fieldset>
				{#if when === "schedule"}
					<div class="flex flex-col gap-1">
						<label for="field-liveAt" class="text-sm font-medium">Goes live at (your time)</label>
						<input
							id="field-liveAt"
							name="liveAt"
							type="datetime-local"
							value={publishValues.liveAt}
							aria-describedby="field-liveAt-hint"
							class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
						/>
						<p id="field-liveAt-hint" class="text-sm text-zinc-600 dark:text-zinc-400">
							At most 7 days ahead. Buyers see the items and a countdown until then.
						</p>
					</div>
				{/if}
				<div class="flex flex-col gap-1">
					<label for="field-duration" class="text-sm font-medium">Runs for</label>
					<select
						id="field-duration"
						name="duration"
						value={publishValues.duration}
						class="rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
					>
						{#each [1, 2, 3, 5, 7, 10, 14] as days (days)}
							<option value={String(days)}>{days} day{days === 1 ? "" : "s"}</option>
						{/each}
					</select>
				</div>
				<button
					type="submit"
					class="self-start rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
					>{when === "now" ? "Go live now" : "Schedule sale"}</button
				>
			</form>
		{:else if sale.status === "scheduled"}
			<p class="mt-3" role="status">
				Scheduled. Goes live {fmt(sale.liveAt)} and closes {fmt(sale.closesAt)}. Buyers can preview it now;
				claims open at go-live.
			</p>
			<form method="POST" action="?/unpublish" use:enhance class="mt-4">
				<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1.5 text-sm"
					>Back to draft</button
				>
			</form>
		{:else if sale.status === "live"}
			<p class="mt-3" role="status">Live until {fmt(sale.closesAt)}.</p>
		{:else}
			<p class="mt-3">This sale is {sale.status}.</p>
		{/if}

		<TimestampPhoto
			saleId={sale.id}
			handle={data.timestamp.handle}
			required={data.timestamp.required}
			photo={data.timestamp.photo}
			disabled={!editable}
			onchange={() => invalidateAll()}
		/>

		{#if sale.status === "draft"}
			<form method="POST" action="?/delete" class="mt-10">
				<button type="submit" class="text-sm text-red-700 underline dark:text-red-400"
					>Delete this draft</button
				>
			</form>
		{/if}
	</div>

	<div>
		<h2 class="text-lg font-semibold">Details</h2>
		{#if form?.action === "details" && "saved" in form}
			<p
				role="status"
				class="mt-2 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200"
			>
				Saved.
			</p>
		{/if}
		{#if detailsErrors["form"]}
			<p role="alert" class="mt-2 text-red-700 dark:text-red-400">{detailsErrors["form"]}</p>
		{/if}
		{#if editable}
			<form
				method="POST"
				action="?/details"
				use:enhance={() =>
					({ update }) =>
						update({ reset: false })}
				class="mt-4 flex flex-col gap-5"
				novalidate
			>
				<SaleDetailsFields
					values={detailsValues}
					errors={detailsErrors}
					canUsePrivate={data.tier === "pro" || sale.visibility === "private"}
					hasPassword={data.hasPassword}
				/>
				<button type="submit" class="self-start rounded-md border border-zinc-400 px-4 py-2"
					>Save details</button
				>
			</form>
		{:else}
			<p class="mt-2 text-sm">Details can't be changed after the sale closes.</p>
		{/if}
	</div>
</section>
