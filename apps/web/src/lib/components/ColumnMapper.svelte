<script lang="ts">
	import { CORE_KEYS, IMPORT_FIELDS, type ColumnMapping } from "@claimsale/core";

	/**
	 * The column-mapping step (PLAN §3c.1): each column of the seller's file maps to
	 * one of our fields, or is ignored. A field takes one column; choosing it for a
	 * second column moves it there.
	 */
	interface Props {
		headers: readonly string[];
		/** The first data row, shown as a sample. */
		sample: readonly string[];
		mapping: ColumnMapping;
		onchange: (mapping: ColumnMapping) => void;
	}

	let { headers, sample, mapping, onchange }: Props = $props();

	const core = [...CORE_KEYS, "item_id"];
	const attributes = [...IMPORT_FIELDS].filter((f) => !core.includes(f)).toSorted();
	/** The fields an import can't do without (game is checked per row). */
	const NEEDED = ["kind", "price"];
	const missing = $derived(
		NEEDED.filter((field) => !Object.values(mapping).includes(field)).concat(
			Object.values(mapping).includes("title") || Object.values(mapping).includes("name")
				? []
				: ["title or name"],
		),
	);

	function choose(header: string, field: string) {
		const next: Record<string, string | null> = { ...mapping };
		if (field !== "") {
			for (const [other, value] of Object.entries(next)) if (value === field) next[other] = null;
		}
		next[header] = field === "" ? null : field;
		onchange(next);
	}
</script>

<div class="overflow-x-auto">
	<table class="w-full border-collapse text-sm">
		<caption class="sr-only">Columns in your file and the fields they fill</caption>
		<thead>
			<tr class="border-b border-zinc-200 text-left dark:border-zinc-800">
				<th scope="col" class="p-2">Column in your file</th>
				<th scope="col" class="p-2">First row</th>
				<th scope="col" class="p-2">Imports as</th>
			</tr>
		</thead>
		<tbody>
			{#each headers as header, column (column)}
				<tr class="border-b border-zinc-100 dark:border-zinc-900">
					<th scope="row" class="p-2 text-left font-medium">{header || `(column ${column + 1})`}</th>
					<td class="max-w-48 truncate p-2 text-zinc-600 dark:text-zinc-400">{sample[column] ?? ""}</td>
					<td class="p-2">
						<select
							aria-label="Import column {header || column + 1} as"
							class="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
							value={mapping[header] ?? ""}
							onchange={(e) => choose(header, e.currentTarget.value)}
						>
							<option value="">Don't import</option>
							<optgroup label="Item">
								{#each core as field (field)}<option value={field}>{field}</option>{/each}
							</optgroup>
							<optgroup label="Card and product details">
								{#each attributes as field (field)}<option value={field}>{field}</option>{/each}
							</optgroup>
						</select>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
{#if missing.length > 0}
	<p class="mt-2 text-sm text-amber-800 dark:text-amber-300" role="status">
		Not mapped yet: {missing.join(", ")}. Rows without them will show errors in the preview.
	</p>
{/if}
