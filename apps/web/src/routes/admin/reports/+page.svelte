<script lang="ts">
	import { enhance } from "$app/forms";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Reports · Admin · ClaimSale</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="mx-auto max-w-3xl px-4 py-10">
	<p class="text-sm"><a href="/admin" class="underline">Admin</a></p>
	<h1 class="mt-2 text-2xl font-bold tracking-tight">Reports</h1>
	{#if form && "message" in form}<p role="alert" class="mt-4 text-red-700 dark:text-red-400">
			{form.message}
		</p>{/if}
	{#if form && "closed" in form}<p role="status" class="mt-4 text-green-800 dark:text-green-300">
			Report {form.closed}.
		</p>{/if}
	{#if data.reports.length === 0}
		<p class="mt-6">No open reports.</p>
	{:else}
		<ul class="mt-6 flex flex-col gap-4">
			{#each data.reports as report (report.id)}
				<li class="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
					<p class="font-medium">{report.reasonLabel}</p>
					<p class="text-sm text-zinc-600 dark:text-zinc-300">
						{report.targetKind} reported by @{report.reporterHandle ?? "?"}{#if report.reportedHandle}
							about <a href="/u/{report.reportedHandle}" class="underline">@{report.reportedHandle}</a>{/if}
						· {new Date(report.createdAt).toUTCString()}
					</p>
					{#if report.messageBody !== null}
						<blockquote class="mt-2 border-l-4 border-zinc-300 pl-3 whitespace-pre-wrap dark:border-zinc-700">
							{report.messageBody}
						</blockquote>
					{/if}
					{#if report.details}<p class="mt-2 text-sm">Reporter's note: {report.details}</p>{/if}
					<div class="mt-3 flex gap-3 text-sm">
						<form method="POST" action="?/close" use:enhance>
							<input type="hidden" name="id" value={report.id} />
							<input type="hidden" name="status" value="resolved" />
							<button type="submit" class="underline">Mark resolved</button>
						</form>
						<form method="POST" action="?/close" use:enhance>
							<input type="hidden" name="id" value={report.id} />
							<input type="hidden" name="status" value="dismissed" />
							<button type="submit" class="underline">Dismiss</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
