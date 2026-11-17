<script lang="ts">
	import { enhance } from "$app/forms";
	import { invalidateAll } from "$app/navigation";
	import { type BulkPricePreview } from "@claimsale/core";
	import BulkMarketPrice from "#lib/components/BulkMarketPrice.svelte";
	import CatalogPicker from "#lib/components/CatalogPicker.svelte";
	import MarketPriceAid from "#lib/components/MarketPriceAid.svelte";
	import PhotoDropzone from "#lib/components/PhotoDropzone.svelte";
	import WizardSteps from "#lib/components/WizardSteps.svelte";
	import { autofillForm } from "#lib/catalog-autofill.ts";
	import { CONDITIONS, GAMES, ITEM_KINDS, NO_GAME, parsePrice, priceInputValue } from "#lib/listing-input.ts";
	import { readAttributes, sellerMarketHint, type CatalogHit, type MarketPrice } from "#lib/market.ts";
	import { moveId } from "#lib/reorder.ts";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();

	const input =
		"min-w-0 rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900 aria-[invalid=true]:border-red-600";
	const addErrors = $derived<Record<string, string>>(
		form?.action === "add" && "errors" in form ? form.errors : {},
	);
	const rowErrors = (id: string): Record<string, string> =>
		(form?.action === "update" || form?.action === "delete") &&
		"itemId" in form &&
		form.itemId === id &&
		"errors" in form
			? form.errors
			: {};
	const reorderError = $derived(form?.action === "reorder" && "errors" in form ? form.errors.form : null);
	const bulkError = $derived(form?.action === "bulkPrice" && "errors" in form ? form.errors.form : null);
	const games = [...GAMES, NO_GAME];

	// Sticky choices for fast entry: game, kind and condition carry over to the next item.
	let game = $state<string>(GAMES[0]?.id ?? NO_GAME.id);
	let kind = $state<string>(ITEM_KINDS[0].id);
	let condition = $state<string>("NM");
	let addTitle = $state("");
	let addPrice = $state("");
	let addAttributes = $state("");
	let addPrices = $state.raw<MarketPrice[] | null>(null);
	let linked = $state<string | null>(null);
	let titleInput: HTMLInputElement | undefined = $state();
	let status = $state("");

	/** Market prices for a picked product (seller-only endpoint, TCG-market-placeholder). */
	async function marketPrices(productId: number): Promise<MarketPrice[] | null> {
		try {
			const response = await fetch(`/sell/${data.sale.id}/catalog/market?product=${productId}`);
			if (!response.ok) return null;
			return ((await response.json()) as { prices: MarketPrice[] }).prices;
		} catch {
			return null;
		}
	}

	const addHint = $derived(
		sellerMarketHint({
			kind,
			attributes: readAttributes(addAttributes),
			prices: addPrices,
			defaultPercent: data.defaultPercent,
		}),
	);

	async function pickForAdd(hit: CatalogHit) {
		const result = autofillForm({ title: addTitle, gameId: game, kind, attributes: addAttributes }, hit);
		if (!result.ok) {
			status = result.message;
			return;
		}
		addTitle = result.value.title;
		game = result.value.gameId;
		addAttributes = result.value.attributes;
		linked = [hit.name, hit.setCode, hit.number].filter(Boolean).join(" · ");
		addPrices = await marketPrices(hit.productId);
	}

	// Table edits that autofill and the % buttons change; cleared when the row is saved.
	let rowTitle = $state<Record<string, string>>({});
	let rowGame = $state<Record<string, string>>({});
	let rowAttributes = $state<Record<string, string>>({});
	let rowPrice = $state<Record<string, string>>({});
	let rowPrices = $state<Record<string, MarketPrice[] | null>>({});
	let selected = $state<Record<string, boolean>>({});

	function clearRow(id: string) {
		for (const record of [rowTitle, rowGame, rowAttributes, rowPrice, rowPrices, selected]) delete record[id];
	}

	async function pickForRow(item: (typeof data.items)[number], hit: CatalogHit) {
		const result = autofillForm(
			{
				title: rowTitle[item.id] ?? item.title,
				gameId: rowGame[item.id] ?? item.gameId,
				kind: item.kind,
				attributes: rowAttributes[item.id] ?? item.attributes,
			},
			hit,
		);
		if (!result.ok) {
			status = result.message;
			return;
		}
		rowTitle[item.id] = result.value.title;
		rowGame[item.id] = result.value.gameId;
		rowAttributes[item.id] = result.value.attributes;
		rowPrices[item.id] = await marketPrices(hit.productId);
		status = `Filled in ${hit.name} for ${item.title}. Save to keep it.`;
	}

	const rowHint = (item: (typeof data.items)[number]) =>
		sellerMarketHint({
			kind: item.kind,
			attributes: readAttributes(rowAttributes[item.id] ?? item.attributes),
			prices: item.id in rowPrices ? (rowPrices[item.id] ?? null) : item.marketPrices,
			defaultPercent: data.defaultPercent,
		});

	// Bulk "N % of market" over the selected rows (D64), applied through ?/bulkPrice.
	let bulkForm: HTMLFormElement | undefined = $state();
	let changesInput: HTMLInputElement | undefined = $state();
	const bulkCandidates = $derived(
		data.items
			.filter((item) => !item.locked)
			.map((item) => {
				const price = parsePrice(item.price);
				return {
					id: item.id,
					label: item.title,
					priceCents: price.ok ? price.value : null,
					marketCents: rowHint(item)?.marketCents ?? null,
					selected: selected[item.id] === true,
				};
			}),
	);
	const anyMarket = $derived(bulkCandidates.some((c) => c.marketCents !== null));

	function applyBulk(preview: BulkPricePreview) {
		if (!changesInput) return;
		changesInput.value = preview.changes.map((c) => `${c.itemId}:${c.toCents}`).join(",");
		status = `Setting ${preview.changes.length} prices to ${preview.percent}% of market.`;
		bulkForm?.requestSubmit();
	}

	// Drag-and-drop and the move buttons reorder locally, then save the whole order.
	let order: readonly string[] = $derived(data.items.map((i) => i.id));
	let dragId = $state<string | null>(null);
	let reorderForm: HTMLFormElement | undefined = $state();
	let orderInput: HTMLInputElement | undefined = $state();
	const byId = $derived(new Map(data.items.map((i) => [i.id, i])));
	const rows = $derived(order.map((id) => byId.get(id)).filter((i) => i !== undefined));

	function saveOrder(next: readonly string[], announce: string) {
		order = next;
		status = announce;
		if (orderInput) orderInput.value = next.join(",");
		reorderForm?.requestSubmit();
	}
	function move(id: string, delta: -1 | 1, title: string) {
		const from = order.indexOf(id);
		const next = moveId(order, id, from + delta);
		if (next !== order) saveOrder(next, `Moved ${title} to position ${from + delta + 1}.`);
	}
	function drop(targetId: string) {
		const moving = dragId;
		dragId = null;
		if (!moving || moving === targetId) return;
		const next = moveId(order, moving, order.indexOf(targetId));
		saveOrder(next, `Moved ${byId.get(moving)?.title ?? "item"} to position ${next.indexOf(moving) + 1}.`);
	}
	const atCap = $derived(data.itemCap !== null && data.items.length >= data.itemCap);
</script>

<svelte:head>
	<title>Items · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-6xl px-4 py-8">
	{#if data.wizard}<WizardSteps current={3} saleId={data.sale.id} />{/if}
	<div class="mt-4 flex flex-wrap items-baseline justify-between gap-4">
		<h1 class="text-2xl font-bold tracking-tight">Items</h1>
		<p class="text-sm text-zinc-600 dark:text-zinc-400">
			{data.items.length}{#if data.itemCap !== null}
				of {data.itemCap}{/if} items · up to {data.photoCap} photos each
			{#if data.canAdd}· <a href="/sell/{data.sale.id}/import" class="underline">Import from a file</a>{/if}
		</p>
	</div>
	<p class="sr-only" role="status" aria-live="polite">{status}</p>

	{#if data.canAdd}
		<form
			method="POST"
			action="?/add"
			class="mt-6 grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 p-3 md:grid-cols-[2fr_1fr_5rem_1fr_1fr_1fr_auto] dark:border-zinc-800"
			aria-label="Add an item"
			novalidate
			use:enhance={() =>
				async ({ result, update }) => {
					await update({ reset: false });
					if (result.type === "success") {
						addTitle = "";
						addPrice = "";
						addAttributes = "";
						addPrices = null;
						linked = null;
						const qty = document.querySelector<HTMLInputElement>(
							'form[aria-label="Add an item"] [name="quantity"]',
						);
						if (qty) qty.value = "";
						status = "Item added.";
					}
					titleInput?.focus();
				}}
		>
			<div class="col-span-full">
				<CatalogPicker
					saleId={data.sale.id}
					game={game === NO_GAME.id ? "" : game}
					{kind}
					onpick={(hit) => void pickForAdd(hit)}
				/>
				{#if linked}
					<p class="mt-1 text-xs">
						Catalog: {linked}
						<button
							type="button"
							class="underline"
							onclick={() => {
								addAttributes = "";
								addPrices = null;
								linked = null;
							}}>Unlink</button
						>
					</p>
				{/if}
			</div>
			<input type="hidden" name="attributes" value={addAttributes} />
			<label class="col-span-2 flex min-w-0 flex-col gap-1 text-sm md:col-span-1">
				Title
				<input
					bind:this={titleInput}
					bind:value={addTitle}
					name="title"
					required
					maxlength="120"
					class={input}
					aria-invalid={addErrors["title"] ? "true" : undefined}
				/>
			</label>
			<div class="flex min-w-0 flex-col gap-1 text-sm">
				<label class="flex min-w-0 flex-col gap-1">
					Price ($)
					<input
						name="price"
						inputmode="decimal"
						required
						bind:value={addPrice}
						placeholder={addHint?.placeholder}
						class={input}
						aria-invalid={addErrors["price"] ? "true" : undefined}
					/>
				</label>
				<MarketPriceAid hint={addHint} onpick={(cents) => (addPrice = priceInputValue(cents))} />
			</div>
			<label class="flex min-w-0 flex-col gap-1 text-sm">
				Qty
				<input
					name="quantity"
					inputmode="numeric"
					placeholder="1"
					class={input}
					aria-invalid={addErrors["quantity"] ? "true" : undefined}
				/>
			</label>
			<label class="flex min-w-0 flex-col gap-1 text-sm">
				Game
				<select name="gameId" bind:value={game} class={input}>
					{#each games as g (g.id)}<option value={g.id}>{g.name}</option>{/each}
				</select>
			</label>
			<label class="flex min-w-0 flex-col gap-1 text-sm">
				Kind
				<select name="kind" bind:value={kind} class={input}>
					{#each ITEM_KINDS as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
				</select>
			</label>
			<label class="flex min-w-0 flex-col gap-1 text-sm">
				Condition
				<select name="condition" bind:value={condition} class={input}>
					<option value="">—</option>
					{#each CONDITIONS as c (c.id)}<option value={c.id}>{c.id}</option>{/each}
				</select>
			</label>
			<button
				type="submit"
				class="self-end rounded-md bg-zinc-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
				disabled={atCap}>Add item</button
			>
			{#if Object.keys(addErrors).length > 0}
				<ul role="alert" class="col-span-full text-sm text-red-700 dark:text-red-400">
					{#each Object.entries(addErrors) as [name, message] (name)}<li>{message}</li>{/each}
				</ul>
			{/if}
			{#if atCap}
				<p class="col-span-full text-sm">Free sales can have up to {data.itemCap} items.</p>
			{/if}
		</form>
	{/if}

	<form method="POST" action="?/reorder" bind:this={reorderForm} use:enhance class="hidden">
		<input type="hidden" name="order" bind:this={orderInput} />
	</form>
	<form
		method="POST"
		action="?/bulkPrice"
		bind:this={bulkForm}
		use:enhance={() =>
			async ({ result, update }) => {
				await update({ reset: false });
				if (result.type === "success") {
					selected = {};
					rowPrice = {};
					status = "Prices updated.";
				}
			}}
		class="hidden"
	>
		<input type="hidden" name="changes" bind:this={changesInput} />
	</form>
	{#if reorderError}<p role="alert" class="mt-2 text-red-700 dark:text-red-400">{reorderError}</p>{/if}
	{#if bulkError}<p role="alert" class="mt-2 text-red-700 dark:text-red-400">{bulkError}</p>{/if}

	{#if data.canEdit && anyMarket}
		<div class="mt-6 max-w-2xl">
			<BulkMarketPrice
				candidates={bulkCandidates}
				scope="selected"
				defaultPercent={data.defaultPercent}
				onapply={applyBulk}
			/>
		</div>
	{/if}

	{#if rows.length === 0}
		<p class="mt-8">
			No items yet. Type a title and price above and press Enter, or
			<a href="/sell/{data.sale.id}/import" class="underline">import a file</a>; add photos once it's in the
			list.
		</p>
	{:else}
		<div class="relative mt-6 overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<caption class="sr-only">Items in this sale, in display order</caption>
				<thead>
					<tr class="border-b border-zinc-200 text-left dark:border-zinc-800">
						<th scope="col" class="p-2">Order</th>
						<th scope="col" class="p-2">Title</th>
						<th scope="col" class="p-2">Price ($)</th>
						<th scope="col" class="p-2">Qty</th>
						<th scope="col" class="p-2">Details</th>
						<th scope="col" class="p-2">Photos</th>
						<th scope="col" class="p-2"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as item, index (item.id)}
						{@const errors = rowErrors(item.id)}
						{@const formId = `item-${item.id}`}
						{@const hint = rowHint(item)}
						<tr
							class="border-b border-zinc-100 align-top dark:border-zinc-900 {dragId === item.id
								? 'opacity-50'
								: ''}"
							ondragover={(e) => e.preventDefault()}
							ondrop={(e) => {
								e.preventDefault();
								drop(item.id);
							}}
							data-testid="item-row"
						>
							<td class="p-2 whitespace-nowrap">
								{#if data.canEdit}
									<span
										draggable="true"
										role="presentation"
										class="cursor-grab select-none px-1"
										title="Drag to reorder"
										ondragstart={() => (dragId = item.id)}
										ondragend={() => (dragId = null)}>⠿</span
									>
									<button
										type="button"
										class="min-h-8 min-w-8 rounded px-1 disabled:opacity-40"
										aria-label="Move {item.title} up"
										disabled={index === 0}
										onclick={() => move(item.id, -1, item.title)}>↑</button
									>
									<button
										type="button"
										class="min-h-8 min-w-8 rounded px-1 disabled:opacity-40"
										aria-label="Move {item.title} down"
										disabled={index === rows.length - 1}
										onclick={() => move(item.id, 1, item.title)}>↓</button
									>
									{#if hint && !item.locked}
										<label class="mt-1 flex items-center gap-1 text-xs">
											<input type="checkbox" bind:checked={selected[item.id]} />
											<span class="sr-only">Select {item.title} for a bulk price</span>
										</label>
									{/if}
								{:else}{index + 1}{/if}
							</td>
							<td class="p-2">
								<input
									form={formId}
									name="title"
									value={rowTitle[item.id] ?? item.title}
									maxlength="120"
									aria-label="Title"
									aria-invalid={errors["title"] ? "true" : undefined}
									class="{input} w-full min-w-48"
									disabled={!data.canEdit}
									oninput={(e) => (rowTitle[item.id] = e.currentTarget.value)}
								/>
							</td>
							<td class="p-2">
								<input
									form={formId}
									name="price"
									value={rowPrice[item.id] ?? item.price}
									inputmode="decimal"
									placeholder={hint?.placeholder}
									aria-label="Price of {item.title}"
									aria-invalid={errors["price"] ? "true" : undefined}
									readonly={item.locked}
									class="{input} w-24"
									disabled={!data.canEdit}
									oninput={(e) => (rowPrice[item.id] = e.currentTarget.value)}
								/>
								{#if data.canEdit && !item.locked}
									<MarketPriceAid
										{hint}
										itemTitle={item.title}
										onpick={(cents) => (rowPrice[item.id] = priceInputValue(cents))}
									/>
								{/if}
							</td>
							<td class="p-2">
								<input
									form={formId}
									name="quantity"
									value={item.quantity}
									inputmode="numeric"
									aria-label="Quantity of {item.title}"
									readonly={item.locked}
									class="{input} w-16"
									disabled={!data.canEdit}
								/>
								{#if item.locked}<p class="mt-1 text-xs">Locked: has claims</p>{/if}
							</td>
							<td class="p-2">
								<div class="flex flex-col gap-1">
									{#if data.canEdit}
										<CatalogPicker
											saleId={data.sale.id}
											game={(rowGame[item.id] ?? item.gameId) === NO_GAME.id
												? ""
												: (rowGame[item.id] ?? item.gameId)}
											kind={item.kind}
											itemTitle={item.title}
											onpick={(hit) => void pickForRow(item, hit)}
										/>
									{/if}
									<select
										form={formId}
										name="gameId"
										value={rowGame[item.id] ?? item.gameId}
										aria-label="Game of {item.title}"
										class={input}
										disabled={!data.canEdit}
										onchange={(e) => (rowGame[item.id] = e.currentTarget.value)}
									>
										{#if !games.some((g) => g.id === item.gameId)}
											<option value={item.gameId}>Choose a game</option>
										{/if}
										{#each games as g (g.id)}<option value={g.id}>{g.name}</option>{/each}
									</select>
									<div class="flex gap-1">
										<select
											form={formId}
											name="kind"
											value={item.kind}
											aria-label="Kind of {item.title}"
											class={input}
											disabled={!data.canEdit}
										>
											{#each ITEM_KINDS as k (k.id)}<option value={k.id}>{k.name}</option>{/each}
										</select>
										<select
											form={formId}
											name="condition"
											value={item.condition}
											aria-label="Condition of {item.title}"
											class={input}
											disabled={!data.canEdit}
										>
											<option value="">—</option>
											{#each CONDITIONS as c (c.id)}<option value={c.id}>{c.id}</option>{/each}
										</select>
									</div>
									<details>
										<summary class="cursor-pointer text-xs underline">Attributes</summary>
										<textarea
											form={formId}
											name="attributes"
											rows="2"
											aria-label="Attributes of {item.title} (JSON)"
											aria-invalid={errors["attributes"] ? "true" : undefined}
											placeholder={'{"set": "LOB", "edition": "1st"}'}
											class="{input} mt-1 w-full font-mono text-xs"
											disabled={!data.canEdit}
											value={rowAttributes[item.id] ?? item.attributes}
											oninput={(e) => (rowAttributes[item.id] = e.currentTarget.value)}></textarea>
									</details>
								</div>
							</td>
							<td class="p-2">
								<PhotoDropzone
									saleId={data.sale.id}
									itemId={item.id}
									itemTitle={item.title}
									photos={item.photos}
									max={data.photoCap}
									disabled={!data.canEdit}
									onchange={() => invalidateAll()}
								/>
							</td>
							<td class="p-2">
								<div class="flex flex-col items-start gap-1">
									{#if data.canEdit}
										<form
											id={formId}
											method="POST"
											action="?/update"
											use:enhance={() =>
												async ({ result, update }) => {
													await update({ reset: false });
													if (result.type === "success") clearRow(item.id);
												}}
										>
											<input type="hidden" name="itemId" value={item.id} />
											<button type="submit" class="rounded-md border border-zinc-400 px-2 py-1"
												>Save<span class="sr-only"> {item.title}</span></button
											>
										</form>
									{/if}
									{#if data.canAdd && !item.locked}
										<form method="POST" action="?/delete" use:enhance>
											<input type="hidden" name="itemId" value={item.id} />
											<button type="submit" class="px-2 py-1 text-red-700 underline dark:text-red-400"
												>Delete<span class="sr-only"> {item.title}</span></button
											>
										</form>
									{/if}
									{#if form?.action === "update" && "saved" in form && form.itemId === item.id}
										<span role="status" class="text-xs text-green-800 dark:text-green-300">Saved</span>
									{/if}
									{#if Object.keys(errors).length > 0}
										<ul role="alert" class="text-xs text-red-700 dark:text-red-400">
											{#each Object.entries(errors) as [name, message] (name)}<li>{message}</li>{/each}
										</ul>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	<p class="mt-8">
		<a
			href="/sell/{data.sale.id}"
			class="rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
			>{data.sale.status === "draft" ? "Next: schedule the sale" : "Back to overview"}</a
		>
	</p>
</section>
