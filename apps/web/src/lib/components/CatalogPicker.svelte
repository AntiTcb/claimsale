<script lang="ts">
	import { productKindFor } from "#lib/catalog-autofill.ts";
	import type { CatalogHit } from "#lib/market.ts";

	/**
	 * The catalog type-ahead (PLAN §3 "Autofill UX", D60): an ARIA combobox over the
	 * TCGCSV catalog. Picking a result hands it to `onpick`; the parent merges only the
	 * catalog fields into the item (TCG-autofill-only).
	 */
	interface Props {
		saleId: string;
		/** The item's game slug, to narrow the search; "" searches every game. */
		game: string;
		kind: string;
		/** Used in the label, e.g. "Find Charizard in the catalog". */
		itemTitle?: string;
		onpick: (hit: CatalogHit) => void;
		disabled?: boolean;
		/** Injectable for tests; defaults to the sale's search endpoint. */
		search?: (query: string, game: string, kind: string) => Promise<CatalogHit[]>;
	}

	let { saleId, game, kind, itemTitle = "", onpick, disabled = false, search }: Props = $props();

	async function fetchHits(query: string, gameId: string, itemKind: string): Promise<CatalogHit[]> {
		const params = new URLSearchParams({ q: query, kind: itemKind });
		if (gameId) params.set("game", gameId);
		const response = await fetch(`/sell/${saleId}/catalog/search?${params}`);
		if (!response.ok) throw new Error("unavailable");
		const body = (await response.json()) as { hits?: CatalogHit[] };
		return body.hits ?? [];
	}

	const uid = $props.id();
	const listId = `catalog-${uid}`;
	let query = $state("");
	let hits = $state<CatalogHit[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let status = $state("");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let latest = 0;

	const label = $derived(itemTitle ? `Find ${itemTitle} in the catalog` : "Find in the catalog");
	const searchable = $derived(productKindFor(kind) !== null);

	function describe(hit: CatalogHit): string {
		return [
			hit.setCode ? `${hit.setName} (${hit.setCode})` : hit.setName,
			hit.number ? `#${hit.number}` : "",
			hit.rarity ?? hit.productType ?? "",
		]
			.filter(Boolean)
			.join(" · ");
	}

	function onInput() {
		clearTimeout(timer);
		const text = query.trim();
		if (text.length < 2) {
			hits = [];
			open = false;
			status = "";
			return;
		}
		timer = setTimeout(async () => {
			const ticket = ++latest;
			try {
				const found = await (search ?? fetchHits)(text, game, kind);
				if (ticket !== latest) return;
				hits = found;
				open = true;
				active = found.length > 0 ? 0 : -1;
				status = found.length === 0 ? "No catalog matches" : `${found.length} catalog matches`;
			} catch {
				if (ticket !== latest) return;
				hits = [];
				open = false;
				status = "Catalog search is unavailable right now";
			}
		}, 200);
	}

	function pick(hit: CatalogHit) {
		onpick(hit);
		query = "";
		hits = [];
		open = false;
		active = -1;
		status = `Filled in ${hit.name}`;
	}

	function onKeydown(event: KeyboardEvent) {
		// Enter picks a match; it never submits the item form the picker sits in.
		if (event.key === "Enter") event.preventDefault();
		if (!open || hits.length === 0) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			active = (active + 1) % hits.length;
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			active = (active - 1 + hits.length) % hits.length;
		} else if (event.key === "Enter" && active >= 0) {
			pick(hits[active]!);
		} else if (event.key === "Escape") {
			open = false;
		}
	}
</script>

{#if searchable}
	<div class="relative">
		<input
			type="search"
			role="combobox"
			aria-label={label}
			aria-autocomplete="list"
			aria-expanded={open}
			aria-controls={listId}
			aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
			placeholder="Find in catalog…"
			autocomplete="off"
			class="w-full min-w-0 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
			bind:value={query}
			oninput={onInput}
			onkeydown={onKeydown}
			onblur={() => setTimeout(() => (open = false), 150)}
			{disabled}
		/>
		<ul
			id={listId}
			role="listbox"
			aria-label="Catalog matches"
			class="absolute z-20 mt-1 max-h-72 w-full min-w-64 overflow-auto rounded-md border border-zinc-300 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900 {open &&
			hits.length > 0
				? ''
				: 'hidden'}"
		>
			{#each hits as hit, index (hit.productId)}
				<li
					id="{listId}-{index}"
					role="option"
					aria-selected={index === active}
					class="cursor-pointer px-2 py-1.5 text-sm {index === active ? 'bg-zinc-100 dark:bg-zinc-800' : ''}"
					onmousedown={(e) => {
						e.preventDefault();
						pick(hit);
					}}
				>
					<span class="font-medium">{hit.name}</span>
					<span class="block text-xs text-zinc-600 dark:text-zinc-400">{describe(hit)}</span>
				</li>
			{/each}
		</ul>
		<p class="sr-only" role="status" aria-live="polite">{status}</p>
	</div>
{/if}
