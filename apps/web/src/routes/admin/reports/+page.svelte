<script lang="ts">
	import { enhance } from "$app/forms";
	import { REPORT_REASON_LABELS } from "#lib/report-reasons.ts";
	import type { PageProps } from "./$types";
	import { useDates } from "#lib/time-zone.svelte.ts";

	let { data, form }: PageProps = $props();
	const dates = useDates();
	const fmt = (ms: number) => dates(ms);
	const input = "rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<svelte:head>
	<title>Reports · Admin · ClaimSale</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Reports ({data.reports.length})</h1>
	{#if form?.message}
		<p role="status" class="mt-3 rounded-md bg-zinc-100 p-3 dark:bg-zinc-800">{form.message}</p>
	{/if}
	{#if data.reports.length === 0}
		<p class="mt-4">No open reports.</p>
	{:else}
		<ul class="mt-4 flex flex-col gap-4">
			{#each data.reports as report (report.id)}
				<li class="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700" data-testid="report">
					<p>
						<strong>{REPORT_REASON_LABELS[report.reason]}</strong> ·
						{#if report.targetKind === "user"}
							<a href="/admin/users?id={report.targetId}" class="underline">user</a>
						{:else}
							{report.targetKind} <code>{report.targetId}</code>
						{/if}
						{#if report.sameTarget > 1}<span> · {report.sameTarget} open reports about it</span>{/if}
					</p>
					<p class="text-zinc-600 dark:text-zinc-400">
						From {report.reporterHandle ? `@${report.reporterHandle}` : "an account without a handle"} · {fmt(
							report.createdAt,
						)}
					</p>
					{#if report.messageBody !== null}
						<blockquote
							class="mt-1 border-l-2 border-zinc-400 pl-2 whitespace-pre-wrap"
							data-testid="reported-message"
						>
							{report.messageBody}
						</blockquote>
						{#if report.messageSenderId}
							<p><a href="/admin/users?id={report.messageSenderId}" class="underline">Sender's account</a></p>
						{/if}
					{/if}
					{#if report.details}<p class="mt-1">{report.details}</p>{/if}
					<form method="POST" use:enhance class="mt-2 flex flex-wrap items-end gap-2">
						<input type="hidden" name="reportId" value={report.id} />
						<label class="flex flex-col">Note <input name="note" maxlength="2000" class={input} /></label>
						<button
							type="submit"
							formaction="?/resolve"
							class="rounded-md bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900"
							>Resolve</button
						>
						<button type="submit" formaction="?/dismiss" class="rounded-md border border-zinc-400 px-3 py-1"
							>Dismiss</button
						>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</section>
