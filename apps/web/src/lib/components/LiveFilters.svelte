<script lang="ts">
	import { gameName } from "#lib/listing-input.ts";
	import { parseDollars, type GridFilter, type StatusFilter } from "#lib/live/state.ts";

	/** The live grid's filters (PLAN §8): status, game, price range, and "my items". */
	interface Props {
		filter: GridFilter;
		/** Game IDs present in the sale; the game filter shows only with more than one. */
		games: readonly string[];
		/** Signed-in buyers can filter to their own items. */
		showMine: boolean;
		onchange: (filter: GridFilter) => void;
	}

	let { filter, games, showMine, onchange }: Props = $props();
	const uid = $props.id();

	const STATUSES: ReadonlyArray<readonly [StatusFilter, string]> = [
		["all", "All"],
		["available", "Available"],
		["backups", "Has claims or offers"],
		["sold", "Sold out"],
		["mine", "My items"],
	];

	const cents = (text: string) => (text.trim() === "" ? null : (parseDollars(text) ?? null));
	const dollars = (value: number | null) => (value === null ? "" : String(value / 100));
</script>

<form
	class="flex flex-wrap items-end gap-x-6 gap-y-3"
	aria-label="Filter items"
	onsubmit={(e) => e.preventDefault()}
>
	<fieldset class="flex flex-wrap gap-2">
		<legend class="mb-1 text-sm font-medium">Show</legend>
		{#each STATUSES.filter(([value]) => value !== "mine" || showMine) as [value, label] (value)}
			<label
				class="cursor-pointer rounded-full border border-zinc-300 px-3 py-1 text-sm has-[:checked]:border-zinc-900 has-[:checked]:bg-zinc-900 has-[:checked]:text-white has-[:focus-visible]:outline-2 dark:border-zinc-700 dark:has-[:checked]:border-zinc-100 dark:has-[:checked]:bg-zinc-100 dark:has-[:checked]:text-zinc-900"
			>
				<input
					type="radio"
					name="status"
					class="sr-only"
					{value}
					checked={filter.status === value}
					onchange={() => onchange({ ...filter, status: value })}
				/>
				{label}
			</label>
		{/each}
	</fieldset>
	{#if games.length > 1}
		<div class="flex flex-col gap-1 text-sm">
			<label for="{uid}-game" class="font-medium">Game</label>
			<select
				id="{uid}-game"
				class="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
				value={filter.gameId}
				onchange={(e) => onchange({ ...filter, gameId: e.currentTarget.value })}
			>
				<option value="">All games</option>
				{#each games as game (game)}<option value={game}>{gameName(game)}</option>{/each}
			</select>
		</div>
	{/if}
	<div class="flex items-end gap-2 text-sm">
		<div class="flex flex-col gap-1">
			<label for="{uid}-min" class="font-medium">Min $</label>
			<input
				id="{uid}-min"
				class="w-20 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
				inputmode="decimal"
				value={dollars(filter.minCents)}
				onchange={(e) => onchange({ ...filter, minCents: cents(e.currentTarget.value) })}
			/>
		</div>
		<div class="flex flex-col gap-1">
			<label for="{uid}-max" class="font-medium">Max $</label>
			<input
				id="{uid}-max"
				class="w-20 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
				inputmode="decimal"
				value={dollars(filter.maxCents)}
				onchange={(e) => onchange({ ...filter, maxCents: cents(e.currentTarget.value) })}
			/>
		</div>
	</div>
</form>
