<script lang="ts">
	import { saleAsText, type TextExportItem } from "@claimsale/core";

	/**
	 * "Copy as text" (PLAN §6): the item list for a Facebook post body. The text is built
	 * in the browser, so "goes live" is in the seller's own time zone.
	 *
	 * @spec DISC-copy-text — only the buyer-facing fields the page passes in.
	 */
	interface Props {
		title: string;
		url: string;
		liveAt: number | null;
		closesAt: number | null;
		items: readonly TextExportItem[];
	}

	let { title, url, liveAt, closesAt, items }: Props = $props();

	let text = $state<string | null>(null);
	let copied = $state<boolean | null>(null);

	const fmt = (ms: number) =>
		new Date(ms).toLocaleString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZoneName: "short",
		});

	async function copy() {
		const when = liveAt ? `Goes live ${fmt(liveAt)}${closesAt ? `, closes ${fmt(closesAt)}` : ""}` : null;
		text = saleAsText({ title, url, when }, items);
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
		} catch {
			// Clipboard access can be refused (or missing in some in-app browsers): the text box is the fallback.
			copied = false;
		}
	}
</script>

<div class="mt-8">
	<h2 class="text-lg font-semibold">Share</h2>
	<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
		The item list as plain text, ready to paste into a Facebook post.
	</p>
	<button type="button" onclick={copy} class="mt-3 rounded-md border border-zinc-400 px-3 py-1.5 text-sm"
		>Copy as text</button
	>
	{#if copied === true}
		<p role="status" class="mt-2 text-sm text-green-800 dark:text-green-300">Copied.</p>
	{:else if copied === false}
		<p role="status" class="mt-2 text-sm">Couldn't reach the clipboard; select the text below and copy it.</p>
	{/if}
	{#if text !== null}
		<label class="mt-2 flex flex-col gap-1 text-sm"
			>Sale as text
			<textarea
				readonly
				rows="10"
				value={text}
				class="rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
			></textarea>
		</label>
	{/if}
</div>
