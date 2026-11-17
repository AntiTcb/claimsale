<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import { parseSpreadsheet, ImportFileError } from "#lib/import/parse.ts";
	import { INVOICE_STATUS_LABELS } from "#lib/invoice-labels.ts";
	import { applicableRows, buildPreview, previewPlan, type PreviewRow } from "#lib/tracking-import.ts";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();

	let rows = $state<PreviewRow[]>([]);
	let error = $state("");
	let busy = $state(false);
	let results = $state<Map<number, { outcome: string; message: string | undefined }>>(new Map());

	const ready = $derived(applicableRows(rows, data.invoices));
	const invoiceFor = (id: string | null) => data.invoices.find((i) => i.id === id);
	const fieldClass =
		"rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900";

	async function onFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		error = "";
		results = new Map();
		if (!file) return;
		try {
			const { table } = await parseSpreadsheet(file);
			rows = buildPreview(table, data.invoices);
			if (rows.length === 0) error = "That file has no tracking rows.";
		} catch (e) {
			error = e instanceof ImportFileError ? e.message : "We couldn't read that file.";
			rows = [];
		}
	}

	function planText(row: PreviewRow): string {
		if (row.error) return row.error;
		if (row.invoiceId === null) return "Not matched: choose the invoice";
		if (row.carrier === null) return "Choose the carrier";
		const plan = previewPlan(row, data.invoices);
		if (plan === null) return "";
		if (plan.action === "ship") return "Will mark shipped";
		if (plan.action === "replace") return "Will replace the tracking";
		if (plan.action === "unchanged") return "Already has this tracking";
		return plan.message;
	}

	async function apply() {
		busy = true;
		error = "";
		try {
			const response = await fetch(`/sell/${data.sale.id}/tracking-import/apply`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ rows: ready.slice(0, 200) }),
			});
			const body = (await response.json()) as {
				rows?: Array<{ row: number; outcome: string; message?: string }>;
				message?: string;
			};
			if (!response.ok || !body.rows) {
				error = body.message ?? "The tracking wasn't applied. Try again.";
				return;
			}
			results = new Map(body.rows.map((r) => [r.row, { outcome: r.outcome, message: r.message }]));
			await invalidateAll();
		} finally {
			busy = false;
		}
	}

	const OUTCOME: Record<string, string> = {
		shipped: "Marked shipped",
		replaced: "Tracking replaced",
		unchanged: "Unchanged",
	};
</script>

<svelte:head>
	<title>Tracking import · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Tracking import</h1>
	<p class="mt-2 text-zinc-600 dark:text-zinc-300">
		Upload the CSV or XLSX from your shipping tool with an <code>invoice_number</code> (or the order ID it
		echoes back) and a <code>tracking_number</code>. Paid invoices are marked shipped; nothing changes until
		you apply.
	</p>
	<div class="mt-4 flex flex-col gap-1">
		<label for="tracking-file" class="text-sm font-medium">Tracking file</label>
		<input id="tracking-file" type="file" accept=".csv,.txt,.xlsx" onchange={onFile} />
	</div>
	{#if error}<p role="alert" class="mt-3 text-red-700 dark:text-red-400">{error}</p>{/if}

	{#if rows.length > 0}
		<div class="mt-6 overflow-x-auto">
			<table class="w-full text-left text-sm">
				<caption class="sr-only">Tracking rows</caption>
				<thead class="border-b border-zinc-200 dark:border-zinc-800">
					<tr>
						<th scope="col" class="py-2 pr-3">Row</th>
						<th scope="col" class="py-2 pr-3">Invoice</th>
						<th scope="col" class="py-2 pr-3">Tracking</th>
						<th scope="col" class="py-2 pr-3">Carrier</th>
						<th scope="col" class="py-2">Result</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.row)}
						{@const invoice = invoiceFor(row.invoiceId)}
						{@const plan = previewPlan(row, data.invoices)}
						{@const result = results.get(row.row)}
						<tr class="border-b border-zinc-100 dark:border-zinc-900" data-testid="tracking-row">
							<td class="py-2 pr-3">{row.row}</td>
							<td class="py-2 pr-3">
								{#if row.error}
									—
								{:else}
									<label class="sr-only" for="row-invoice-{row.row}">Invoice for row {row.row}</label>
									<select id="row-invoice-{row.row}" class={fieldClass} bind:value={row.invoiceId}>
										<option value={null}>Choose…</option>
										{#each data.invoices as option (option.id)}
											<option value={option.id}
												>{option.number} · @{option.buyerHandle ?? "buyer"} · {INVOICE_STATUS_LABELS[
													option.status
												]}</option
											>
										{/each}
									</select>
								{/if}
							</td>
							<td class="py-2 pr-3 font-mono">{row.trackingNumber}</td>
							<td class="py-2 pr-3">
								{#if !row.error}
									<label class="sr-only" for="row-carrier-{row.row}">Carrier for row {row.row}</label>
									<select id="row-carrier-{row.row}" class={fieldClass} bind:value={row.carrier}>
										<option value={null}>Choose…</option>
										{#each row.carrier && !row.carrierCandidates.includes(row.carrier) ? [row.carrier, ...row.carrierCandidates] : row.carrierCandidates as name (name)}
											<option value={name}>{name}</option>
										{/each}
									</select>
								{/if}
							</td>
							<td class="py-2">
								{#if result}
									<span class={result.outcome === "error" ? "text-red-700 dark:text-red-400" : ""}
										>{OUTCOME[result.outcome] ?? result.message}</span
									>
								{:else}
									{planText(row)}
									{#if invoice && (plan?.action === "replace" || (plan?.action === "rejected" && plan.code === "replace_unconfirmed"))}
										<label class="ml-2 inline-flex items-center gap-1">
											<input type="checkbox" bind:checked={row.replace} /> Replace {invoice.tracking
												?.number ?? "missing tracking"}
										</label>
									{/if}
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="mt-4 flex items-center gap-3">
			<button
				type="button"
				class="rounded-md bg-zinc-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
				disabled={busy || ready.length === 0}
				onclick={apply}>Apply {ready.length} {ready.length === 1 ? "row" : "rows"}</button
			>
			{#if ready.length > 200}<span class="text-sm"
					>The first 200 rows apply now; apply again for the rest.</span
				>{/if}
		</div>
	{/if}
</section>
