<script lang="ts">
	import {
		autoMapColumns,
		detectPreset,
		encodeCsv,
		enabledGames,
		gameBySlug,
		ITEM_KIND_LABELS,
		ITEM_KINDS,
		planImport,
		templateRows,
		type ColumnMapping,
		type ImportPreset,
		type ItemKind,
		type MappedRow,
	} from "@claimsale/core";
	import BulkMarketPrice from "#lib/components/BulkMarketPrice.svelte";
	import ColumnMapper from "#lib/components/ColumnMapper.svelte";
	import { parseSpreadsheet, ImportFileError, type FileFormat, type Table } from "#lib/import/parse.ts";
	import {
		missingPhotos,
		readPhotoZip,
		uploadRowPhotos,
		PhotoZipError,
		type PhotoZip,
	} from "#lib/import/photos.ts";
	import {
		blankPriceItems,
		chunk,
		fillPrices,
		keptByFile,
		mappedRows,
		previewRows,
		resultsCsv,
		setCell,
		type RowOutcome,
	} from "#lib/import/session.ts";
	import { pickMarketQuote, type CatalogHit, type MarketPrice } from "#lib/market.ts";
	import type { PageProps } from "./$types";

	let { data }: PageProps = $props();

	type Step = "upload" | "map" | "preview" | "applying" | "done";
	type Match =
		| { status: "matched"; product: CatalogHit }
		| { status: "ambiguous"; candidates: CatalogHit[] }
		| { status: "unmatched" };

	let step = $state<Step>("upload");
	let error = $state("");
	let busy = $state(false);
	let status = $state("");

	let fileName = $state("");
	let format = $state<FileFormat>("csv");
	let table = $state.raw<Table>([]);
	let zip = $state.raw<PhotoZip | null>(null);
	let preset = $state.raw<ImportPreset | null>(null);
	let mapping = $state.raw<ColumnMapping>({});
	let rows = $state.raw<MappedRow[]>([]);
	let matches = $state.raw<Map<number, Match>>(new Map());
	let prices = $state.raw<Map<number, MarketPrice[]>>(new Map());
	let removeMissing = $state(false);
	let outcomes = $state.raw<Map<number, RowOutcome>>(new Map());
	let importId = $state("");
	let applied = $state(0);

	// Template download (PLAN §3c.1: one template per item type).
	const games = enabledGames();
	let templateGame = $state(games[0]?.slug ?? "");
	let templateKind = $state<ItemKind>("single");

	const headers = $derived(table[0] ?? []);
	const preview = $derived(previewRows(rows, data.tier));
	const ready = $derived(preview.rows.filter((r) => r.ok));
	const failing = $derived(preview.rows.filter((r) => !r.ok));
	const plan = $derived(
		planImport({
			rows: ready.flatMap((r) => (r.ok ? [{ row: r.row, item: r.item }] : [])),
			existing: data.existing,
			removeMissing,
			sellerTier: data.tier,
		}),
	);
	const blanks = $derived(blankPriceItems(rows, data.tier));
	const blankCandidates = $derived(
		blanks.map(({ row, item }) => {
			const match = matches.get(row);
			const product = match?.status === "matched" ? match.product : null;
			const quote = product ? pickMarketQuote(prices.get(product.productId) ?? [], item.attributes) : null;
			return {
				id: String(row),
				label: `Row ${row}: ${item.title}`,
				priceCents: null,
				marketCents: quote?.marketCents ?? null,
			};
		}),
	);

	function download(name: string, text: string) {
		const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function downloadTemplate() {
		const game = templateKind === "accessory" ? null : (gameBySlug(templateGame) ?? null);
		download(
			`claimsale-${templateKind}${game ? `-${game.slug}` : ""}-template.csv`,
			encodeCsv(templateRows(templateKind, game)),
		);
	}

	const mappingKey = (h: readonly string[]) => `claimsale:import-mapping:${h.join("\u0001")}`;

	function rememberedMapping(h: readonly string[]): ColumnMapping | null {
		try {
			const saved = localStorage.getItem(mappingKey(h));
			return saved ? (JSON.parse(saved) as ColumnMapping) : null;
		} catch {
			return null;
		}
	}

	async function readFiles(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const sheet = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
		const photos = (form.elements.namedItem("photos") as HTMLInputElement).files?.[0];
		error = "";
		if (!sheet) {
			error = "Choose a CSV or Excel file.";
			return;
		}
		busy = true;
		try {
			const parsed = await parseSpreadsheet(sheet);
			if (parsed.table.length < 2) throw new ImportFileError("That file has no rows under its header.");
			table = parsed.table;
			format = parsed.format;
			fileName = sheet.name;
			zip = photos ? await readPhotoZip(new Uint8Array(await photos.arrayBuffer())) : null;
			preset = detectPreset(parsed.table[0]!);
			mapping = rememberedMapping(parsed.table[0]!) ?? autoMapColumns(parsed.table[0]!).mapping;
			step = "map";
		} catch (e) {
			error =
				e instanceof ImportFileError || e instanceof PhotoZipError
					? e.message
					: "That file couldn't be read.";
		} finally {
			busy = false;
		}
	}

	async function toPreview(usePreset: boolean) {
		error = "";
		if (!usePreset) {
			preset = null;
			try {
				localStorage.setItem(mappingKey(headers), JSON.stringify(mapping));
			} catch {
				// Remembering the mapping is a convenience only.
			}
		}
		rows = mappedRows(table, preset ? { kind: "preset", preset } : { kind: "columns", mapping });
		step = "preview";
		await matchCatalog();
	}

	/** TCG-catalog-match for the preview, 100 rows a request; rows with blank prices included. */
	async function matchCatalog() {
		const candidates = [
			...ready.flatMap((r) => (r.ok ? [{ row: r.row, item: r.item }] : [])),
			...blanks,
		].filter((r) => r.item.kind !== "accessory" && r.item.kind !== "lot" && r.item.game !== null);
		if (candidates.length === 0) return;
		busy = true;
		status = "Matching rows to the catalog…";
		const nextMatches = new Map<number, Match>();
		const nextPrices = new Map<number, MarketPrice[]>();
		try {
			for (const part of chunk(candidates)) {
				// oxlint-disable-next-line no-await-in-loop -- one request at a time
				const response = await fetch(`/sell/${data.sale.id}/import/match`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						rows: part.map(({ row, item }) => ({
							row,
							game: item.game,
							kind: item.kind,
							attributes: item.attributes,
						})),
					}),
				});
				if (!response.ok) throw new Error("match failed");
				// oxlint-disable-next-line no-await-in-loop
				const body = (await response.json()) as {
					matches: ({ row: number } & Match)[];
					prices: Record<string, MarketPrice[]>;
				};
				for (const m of body.matches) nextMatches.set(m.row, m);
				for (const [id, list] of Object.entries(body.prices)) nextPrices.set(Number(id), list);
			}
			matches = nextMatches;
			prices = nextPrices;
			status = "";
		} catch {
			status = "The catalog couldn't be checked; rows import as entered.";
		} finally {
			busy = false;
		}
	}

	function choose(row: number, tcgplayerId: string) {
		const match = matches.get(row);
		if (match?.status !== "ambiguous") return;
		const product = match.candidates.find((c) => String(c.tcgplayerProductId) === tcgplayerId);
		if (!product) return;
		rows = setCell(rows, row, "tcgplayer_product_id", tcgplayerId);
		matches = new Map(matches).set(row, { status: "matched", product });
	}

	const photoNames = (row: MappedRow) =>
		(row.cells["photos"] ?? "")
			.split(";")
			.map((n) => n.trim())
			.filter(Boolean);

	async function apply() {
		error = "";
		if (!importId) importId = crypto.randomUUID();
		step = "applying";
		const batches = chunk(rows);
		const keep = removeMissing ? keptByFile(rows) : null;
		const next = new Map(outcomes);
		try {
			for (const [index, batch] of batches.entries()) {
				if (batch.every((r) => next.has(r.row))) continue;
				status = `Importing rows ${index * 100 + 1}–${index * 100 + batch.length} of ${rows.length}…`;
				// oxlint-disable-next-line no-await-in-loop -- batches go in order (PLAN §3c.4)
				const response = await fetch(`/sell/${data.sale.id}/import/apply`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						importId,
						format,
						totalRows: rows.length,
						rows: batch,
						...(index === 0 && keep ? { removeMissing: keep } : {}),
					}),
				});
				// oxlint-disable-next-line no-await-in-loop
				const body = (await response.json().catch(() => ({}))) as {
					rows?: RowOutcome[];
					message?: string;
				};
				if (!response.ok || !body.rows) throw new Error(body.message ?? "The import stopped. Try again.");
				const byRow = new Map(batch.map((r) => [r.row, r]));
				for (const result of body.rows) {
					let outcome: RowOutcome = result;
					const mapped = byRow.get(result.row);
					const names = mapped ? photoNames(mapped) : [];
					if (result.itemId && result.outcome !== "error" && names.length > 0) {
						status = `Uploading photos for row ${result.row}…`;
						// oxlint-disable-next-line no-await-in-loop -- one photo at a time
						const photos = await uploadRowPhotos({ saleId: data.sale.id, itemId: result.itemId, names, zip });
						if (photos.problems.length > 0) {
							outcome = {
								...result,
								message: [result.message, `Photos: ${photos.problems.join("; ")}`].filter(Boolean).join(". "),
							};
						}
					}
					next.set(result.row, outcome);
				}
				outcomes = new Map(next);
				applied = next.size;
			}
			status = "";
			step = "done";
		} catch (e) {
			outcomes = new Map(next);
			applied = next.size;
			error = e instanceof Error ? e.message : "The import stopped. Try again.";
			status = "";
			step = "preview";
		}
	}

	const count = (outcome: RowOutcome["outcome"]) =>
		[...outcomes.values()].filter((o) => o.outcome === outcome).length;

	function restart() {
		step = "upload";
		table = [];
		rows = [];
		zip = null;
		matches = new Map();
		prices = new Map();
		outcomes = new Map();
		importId = "";
		applied = 0;
		error = "";
	}

	const input =
		"rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900";
	const button =
		"rounded-md bg-zinc-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900";
</script>

<svelte:head>
	<title>Import items · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-6xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Import items</h1>
	<p class="sr-only" role="status" aria-live="polite">{status}</p>
	{#if status}<p class="mt-2 text-sm" aria-hidden="true">{status}</p>{/if}
	{#if error}<p role="alert" class="mt-2 text-red-700 dark:text-red-400">{error}</p>{/if}

	{#if data.importable}
		<p class="mt-4">{data.importable}.</p>
	{:else if step === "upload"}
		<p class="mt-2 max-w-prose text-sm text-zinc-700 dark:text-zinc-300">
			Upload a CSV or Excel file: our template, an items export from ClaimSale, or a TCGplayer or ManaBox
			export. Rows with the same SKU (or item ID) as an item already in this sale update it. Nothing changes
			until you confirm.
		</p>
		<form class="mt-6 flex max-w-xl flex-col gap-4" onsubmit={readFiles}>
			<label class="flex flex-col gap-1 text-sm">
				Spreadsheet (CSV or .xlsx)
				<input name="file" type="file" accept=".csv,.txt,.xlsx,text/csv" required class={input} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				Photos (optional ZIP; name the files in the photos column)
				<input name="photos" type="file" accept=".zip,application/zip" class={input} />
			</label>
			<button type="submit" class="{button} self-start" disabled={busy}>Read file</button>
		</form>

		<details class="mt-8 max-w-xl">
			<summary class="cursor-pointer text-sm underline">Download a template</summary>
			<div class="mt-3 flex flex-wrap items-end gap-2">
				<label class="flex flex-col gap-1 text-sm">
					Kind
					<select bind:value={templateKind} class={input}>
						{#each ITEM_KINDS as kind (kind)}<option value={kind}>{ITEM_KIND_LABELS[kind]}</option>{/each}
					</select>
				</label>
				{#if templateKind !== "accessory"}
					<label class="flex flex-col gap-1 text-sm">
						Game
						<select bind:value={templateGame} class={input}>
							{#each games as game (game.slug)}<option value={game.slug}>{game.name}</option>{/each}
						</select>
					</label>
				{/if}
				<button
					type="button"
					class="rounded-md border border-zinc-400 px-3 py-1.5 text-sm"
					onclick={downloadTemplate}>Download CSV template</button
				>
			</div>
		</details>
	{:else if step === "map"}
		<p class="mt-2 text-sm">
			{fileName}: {table.length - 1} rows{zip ? `, ${zip.count} photos in the ZIP` : ""}.
		</p>
		{#if preset}
			<p class="mt-4">This looks like a <strong>{preset.name}</strong>. Its columns are mapped for you.</p>
			{#if preset.id === "manabox"}
				<p class="mt-1 text-sm">
					ManaBox has no asking prices: you can set them to a % of market in the next step.
				</p>
			{/if}
			<div class="mt-4 flex gap-3">
				<button type="button" class={button} onclick={() => toPreview(true)}>Continue</button>
				<button type="button" class="text-sm underline" onclick={() => (preset = null)}
					>Map the columns myself</button
				>
			</div>
		{:else}
			<div class="mt-4">
				<ColumnMapper {headers} sample={table[1] ?? []} {mapping} onchange={(next) => (mapping = next)} />
			</div>
			<div class="mt-4 flex gap-3">
				<button type="button" class={button} onclick={() => toPreview(false)}>Preview import</button>
				<button type="button" class="text-sm underline" onclick={restart}>Choose another file</button>
			</div>
		{/if}
	{:else if step === "preview" || step === "applying"}
		{#if preview.fileError}
			<p role="alert" class="mt-4 text-red-700 dark:text-red-400">{preview.fileError}</p>
			<button type="button" class="mt-4 text-sm underline" onclick={restart}>Choose another file</button>
		{:else}
			<p class="mt-2" data-testid="import-summary">
				{ready.length} of {preview.rows.length} rows ready: {plan.creates.length} new, {plan.updates.length} updated,
				{plan.outcomes.filter((o) => o.outcome === "skipped").length} unchanged{#if failing.length > 0}; {failing.length}
					with errors (they won't import){/if}.
			</p>
			{#if plan.cap.exceeded}
				<p class="mt-1 text-amber-800 dark:text-amber-300">
					Free sales hold {data.itemCap} items: only {plan.cap.fits} new row{plan.cap.fits === 1 ? "" : "s"} fit.
				</p>
			{/if}

			{#if blanks.length > 0}
				<div class="mt-4 max-w-2xl">
					<BulkMarketPrice
						candidates={blankCandidates}
						scope="blank"
						defaultPercent={data.defaultPercent}
						disabled={busy || step === "applying"}
						onapply={(p) => {
							rows = fillPrices(rows, p);
							status = `Set ${p.changes.length} prices to ${p.percent}% of market.`;
						}}
					/>
				</div>
			{/if}

			<div class="mt-6 overflow-x-auto">
				<table class="w-full border-collapse text-sm">
					<caption class="sr-only">Rows of {fileName} and what will happen to each</caption>
					<thead>
						<tr class="border-b border-zinc-200 text-left dark:border-zinc-800">
							<th scope="col" class="p-2">Row</th>
							<th scope="col" class="p-2">Title</th>
							<th scope="col" class="p-2">Price</th>
							<th scope="col" class="p-2">Catalog</th>
							<th scope="col" class="p-2">Photos</th>
							<th scope="col" class="p-2">Result</th>
						</tr>
					</thead>
					<tbody>
						{#each preview.rows as result (result.row)}
							{@const mapped = rows.find((r) => r.row === result.row)}
							{@const match = matches.get(result.row)}
							{@const names = mapped ? photoNames(mapped) : []}
							{@const missing = missingPhotos(names, zip)}
							{@const planned = plan.outcomes.find((o) => o.row === result.row)}
							<tr class="border-b border-zinc-100 align-top dark:border-zinc-900" data-testid="import-row">
								<td class="p-2">{result.row}</td>
								<td class="p-2">{mapped?.cells["title"] || mapped?.cells["name"] || "—"}</td>
								<td class="p-2">{mapped?.cells["price"] || "—"}</td>
								<td class="p-2">
									{#if match?.status === "matched"}
										{match.product.name}<span class="block text-xs text-zinc-600 dark:text-zinc-400"
											>{match.product.setName}{match.product.number ? ` #${match.product.number}` : ""}</span
										>
									{:else if match?.status === "ambiguous"}
										<select
											aria-label="Catalog product for row {result.row}"
											class={input}
											onchange={(e) => choose(result.row, e.currentTarget.value)}
										>
											<option value="">Choose one ({match.candidates.length})…</option>
											{#each match.candidates as c (c.productId)}
												<option value={String(c.tcgplayerProductId)}
													>{c.name} · {c.setName}{c.number ? ` #${c.number}` : ""}</option
												>
											{/each}
										</select>
									{:else if match}
										<span class="text-zinc-600 dark:text-zinc-400">Not in the catalog</span>
									{/if}
								</td>
								<td class="p-2">
									{#if names.length === 0}
										<span class="text-amber-800 dark:text-amber-300">Needs a photo</span>
									{:else if missing.length > 0}
										<span class="text-red-700 dark:text-red-400">Missing: {missing.join(", ")}</span>
									{:else}
										{names.length}
									{/if}
								</td>
								<td class="p-2">
									{#if !result.ok}
										<ul class="text-red-700 dark:text-red-400">
											{#each result.errors as e, i (i)}<li>
													{e.field ? `${e.field}: ` : ""}{e.message}
												</li>{/each}
										</ul>
									{:else if outcomes.has(result.row)}
										{outcomes.get(result.row)?.outcome}
									{:else if planned?.outcome === "error"}
										<span class="text-red-700 dark:text-red-400">{planned.message}</span>
									{:else if planned}
										{planned.outcome === "created"
											? "New item"
											: planned.outcome === "updated"
												? "Update"
												: "Unchanged"}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<label class="mt-4 flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					bind:checked={removeMissing}
					disabled={step === "applying" || importId !== ""}
				/>
				Remove items not in this file ({data.existing.length} in the sale now)
			</label>
			<div class="mt-4 flex flex-wrap items-center gap-3">
				<button
					type="button"
					class={button}
					disabled={busy || step === "applying" || ready.length === 0}
					onclick={apply}
					>{importId ? "Resume import" : `Import ${ready.length} row${ready.length === 1 ? "" : "s"}`}</button
				>
				{#if step === "applying"}<span class="text-sm">{applied} of {rows.length} rows done…</span>{/if}
				<button type="button" class="text-sm underline" disabled={step === "applying"} onclick={restart}
					>Start over</button
				>
			</div>
		{/if}
	{:else if step === "done"}
		<p class="mt-4" data-testid="import-done">
			Done: {count("created")} created, {count("updated")} updated, {count("skipped")} unchanged, {count(
				"error",
			)} with errors.
		</p>
		<div class="mt-4 flex flex-wrap gap-3">
			<a href="/sell/{data.sale.id}/items" class={button}>Go to items</a>
			<button
				type="button"
				class="rounded-md border border-zinc-400 px-4 py-2"
				onclick={() =>
					download(`${fileName.replace(/\.[^.]+$/, "")}-results.csv`, resultsCsv(table, outcomes))}
				>Download results (CSV)</button
			>
			<button type="button" class="px-4 py-2 underline" onclick={restart}>Import another file</button>
		</div>
		<div class="mt-6 overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<caption class="sr-only">Import results by row</caption>
				<thead>
					<tr class="border-b border-zinc-200 text-left dark:border-zinc-800">
						<th scope="col" class="p-2">Row</th>
						<th scope="col" class="p-2">Result</th>
						<th scope="col" class="p-2">Details</th>
					</tr>
				</thead>
				<tbody>
					{#each [...outcomes.values()].sort((a, b) => a.row - b.row) as o (o.row)}
						<tr class="border-b border-zinc-100 dark:border-zinc-900" data-testid="result-row">
							<td class="p-2">{o.row}</td>
							<td class="p-2">{o.outcome}</td>
							<td class="p-2">{o.message}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
