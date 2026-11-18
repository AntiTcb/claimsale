<script lang="ts">
	import { EXPORT_KIND_LABELS, EXPORT_KINDS } from "@claimsale/core";
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import { onMount } from "svelte";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const running = $derived(data.jobs.some((j) => j.status === "running"));
	const at = (ms: number | null) => (ms === null ? "" : new Date(ms).toLocaleString());
	const STATUS = { running: "Preparing…", ready: "Ready", failed: "Failed", expired: "Expired" } as const;
	const fieldClass =
		"rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";

	// Exports build in the background: refresh while any is still running.
	onMount(() => {
		const timer = setInterval(() => {
			if (running) void invalidateAll();
		}, 2000);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Exports · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-3xl px-4 py-10">
	<p class="text-sm"><a href="/sell" class="underline">Your sales</a></p>
	<h1 class="mt-2 text-2xl font-bold tracking-tight">Exports</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		Files are prepared in the background and can be downloaded for 24 hours. Order files hold your buyers'
		handles, names and shipping addresses only.
	</p>
	{#if form && "message" in form}<p role="alert" class="mt-3 text-red-700 dark:text-red-400">
			{form.message}
		</p>{/if}
	{#if form && "requested" in form}<p role="status" class="mt-3 text-green-800 dark:text-green-300">
			Export requested. It appears below when it's ready.
		</p>{/if}

	{#if data.sales.length === 0}
		<p class="mt-6">You have no sales to export yet.</p>
	{:else}
		<form method="POST" use:enhance class="mt-6 flex flex-wrap items-end gap-3">
			<div class="flex flex-col gap-1">
				<label for="export-sale" class="text-sm font-medium">Sale</label>
				<select id="export-sale" name="saleId" class={fieldClass}>
					{#each data.sales as sale (sale.id)}
						<option value={sale.id} selected={sale.id === data.selected}>{sale.title}</option>
					{/each}
				</select>
			</div>
			<div class="flex flex-col gap-1">
				<label for="export-kind" class="text-sm font-medium">Export</label>
				<select id="export-kind" name="kind" class={fieldClass}>
					{#each EXPORT_KINDS as kind (kind)}<option value={kind}>{EXPORT_KIND_LABELS[kind]}</option>{/each}
				</select>
			</div>
			<button
				type="submit"
				class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
				>Export CSV</button
			>
		</form>
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Recent exports</h2>
	{#if data.jobs.length === 0}
		<p class="mt-3">None yet.</p>
	{:else}
		<ul class="mt-3 flex flex-col gap-2" aria-live="polite">
			{#each data.jobs as job (job.id)}
				<li class="rounded-md border border-zinc-200 p-3 dark:border-zinc-800" data-testid="export-job">
					<span class="font-medium">{EXPORT_KIND_LABELS[job.kind]}</span> · {job.saleTitle ?? "Deleted sale"} ·
					{at(job.createdAt)} · <span>{STATUS[job.status]}</span>
					{#if job.status === "ready"}
						· <a class="underline" href="/sell/exports/{job.id}" download
							>Download{" "}<span class="sr-only">{EXPORT_KIND_LABELS[job.kind]} for {job.saleTitle}</span></a
						>
						<span class="text-sm text-zinc-600 dark:text-zinc-400"
							>({job.rowCount} rows, until {at(job.expiresAt)})</span
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
