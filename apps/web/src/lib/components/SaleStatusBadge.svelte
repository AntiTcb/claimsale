<script lang="ts">
	import type { SaleStatus } from "@claimsale/core";

	interface Props {
		status: SaleStatus;
		/** For scheduled sales: when claims open (server milliseconds). */
		liveAt?: number | null;
	}

	let { status, liveAt = null }: Props = $props();

	const LABELS: Record<SaleStatus, string> = {
		draft: "Draft",
		scheduled: "Scheduled",
		live: "Live",
		closed: "Closed",
		archived: "Archived",
		deleted: "Deleted",
	};
	const STYLES: Record<SaleStatus, string> = {
		draft: "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
		scheduled: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100",
		live: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100",
		closed: "bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
		archived: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
		deleted: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
	};
	const when = $derived(
		status === "scheduled" && liveAt !== null
			? new Date(liveAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
			: null,
	);
</script>

<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium {STYLES[status]}">
	{LABELS[status]}{#if when}<span
			>· opens <time datetime={new Date(liveAt ?? 0).toISOString()}>{when}</time></span
		>{/if}
</span>
