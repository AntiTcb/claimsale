<script lang="ts">
	import { enhance } from "$app/forms";
	import { MIN_CONTEST_TEXT } from "@claimsale/core";
	import { PHASE_LABELS, RESCIND_REASON_LABELS } from "#lib/control-room.ts";
	import type { PageProps } from "./$types";

	let { data, form }: PageProps = $props();
	const fmt = (ms: number) =>
		new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
</script>

<svelte:head>
	<title>Rescinded wins · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-3xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Rescinded wins</h1>
	<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
		When a seller rescinds something you won, the reason decides whose record it affects. If you disagree,
		contest it within 7 days and an admin decides.
	</p>
	{#if form && "error" in form}
		<p role="alert" class="mt-3 rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-200">
			{form.error}
		</p>
	{:else if form?.message}
		<p
			role="status"
			class="mt-3 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-200"
		>
			{form.message}
		</p>
	{/if}

	{#if data.rescinds.length === 0}
		<p class="mt-6">No seller has rescinded a win of yours.</p>
	{:else}
		<ul class="mt-6 flex flex-col gap-4">
			{#each data.rescinds as rescind (rescind.id)}
				<li
					class="rounded-md border border-zinc-300 p-4 text-sm dark:border-zinc-700"
					data-testid="my-rescind"
				>
					<p>
						<strong>{rescind.itemTitle}</strong> in “{rescind.saleTitle}”{rescind.sellerHandle
							? ` by @${rescind.sellerHandle}`
							: ""}
					</p>
					<p class="text-zinc-600 dark:text-zinc-400">
						{RESCIND_REASON_LABELS[rescind.reasonCode]} · {PHASE_LABELS[rescind.phase]}{rescind.resolvedFault
							? ` · resolved as ${rescind.resolvedFault} fault`
							: ""}{rescind.refundOwed ? " · refund owed to you" : ""} · {fmt(rescind.createdAt)}
					</p>
					<p class="mt-2">“{rescind.explanation}”</p>

					{#if rescind.phase === "awaiting_buyer"}
						<p class="mt-3">
							The seller says you both agreed to cancel. Agree, or dispute it{rescind.answerBy
								? ` by ${fmt(rescind.answerBy)}`
								: ""}; no answer counts as agreeing.
						</p>
						<div class="mt-2 flex gap-2">
							<form method="POST" action="?/agree" use:enhance>
								<input type="hidden" name="rescindId" value={rescind.id} />
								<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1">Agree</button>
							</form>
							<form method="POST" action="?/dispute" use:enhance>
								<input type="hidden" name="rescindId" value={rescind.id} />
								<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1">Dispute</button>
							</form>
						</div>
					{:else if rescind.contestUntil !== null}
						<details class="mt-3">
							<summary class="cursor-pointer underline">Contest (until {fmt(rescind.contestUntil)})</summary>
							<form method="POST" action="?/contest" use:enhance class="mt-2 flex flex-col gap-2">
								<input type="hidden" name="rescindId" value={rescind.id} />
								<label class="flex flex-col gap-1">
									Your side (an admin reads it)
									<textarea
										name="text"
										rows="3"
										required
										minlength={MIN_CONTEST_TEXT}
										maxlength="2000"
										class="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
									></textarea>
								</label>
								<button
									type="submit"
									class="self-start rounded-md bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900"
									>Send contest</button
								>
							</form>
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
