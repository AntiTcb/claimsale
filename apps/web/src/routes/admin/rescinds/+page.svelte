<script lang="ts">
	import { enhance } from "$app/forms";
	import { PHASE_LABELS, RESCIND_REASON_LABELS } from "#lib/control-room.ts";
	import type { PageProps } from "./$types";
	import { useDates } from "#lib/time-zone.svelte.ts";

	let { data, form }: PageProps = $props();
	const dates = useDates();
	const fmt = (ms: number) => dates(ms);
	const who = (handle: string | null) => (handle ? `@${handle}` : "an account without a handle");
</script>

<svelte:head>
	<title>Rescinds · Admin · ClaimSale</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Rescind disputes</h1>
	<p class="text-sm text-zinc-600 dark:text-zinc-400">
		Until you resolve one, it counts for no one. Pick whose fault it was; a buyer-fault rescind you move to
		the seller or neutral counts toward flagging the seller.
	</p>
	{#if form?.message}
		<p role="status" class="mt-3 rounded-md bg-zinc-100 p-3 dark:bg-zinc-800">{form.message}</p>
	{/if}

	<h2 class="mt-8 text-lg font-semibold">Waiting for a decision ({data.queue.length})</h2>
	{#if data.queue.length === 0}
		<p class="mt-3">Nothing to resolve.</p>
	{:else}
		<ul class="mt-4 flex flex-col gap-4">
			{#each data.queue as rescind (rescind.id)}
				<li
					class="rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700"
					data-testid="disputed-rescind"
				>
					<p>
						<strong>{rescind.itemTitle}</strong> in “{rescind.saleTitle}”: {who(rescind.sellerHandle)} rescinded
						{who(rescind.buyerHandle)}'s win
					</p>
					<p class="text-zinc-600 dark:text-zinc-400">
						{RESCIND_REASON_LABELS[rescind.reasonCode]} · {PHASE_LABELS[rescind.phase]} · {fmt(
							rescind.createdAt,
						)}
					</p>
					<p class="mt-2"><span class="font-medium">Seller:</span> {rescind.explanation}</p>
					{#if rescind.contestText}
						<p class="mt-1"><span class="font-medium">Buyer:</span> {rescind.contestText}</p>
					{/if}
					<form method="POST" action="?/resolve" use:enhance class="mt-3 flex flex-wrap items-end gap-3">
						<input type="hidden" name="rescindId" value={rescind.id} />
						<fieldset class="flex gap-3">
							<legend class="sr-only">Whose fault</legend>
							<label class="flex items-center gap-1"
								><input type="radio" name="fault" value="buyer" required /> Buyer</label
							>
							<label class="flex items-center gap-1"
								><input type="radio" name="fault" value="seller" /> Seller</label
							>
							<label class="flex items-center gap-1"
								><input type="radio" name="fault" value="neutral" /> Neutral</label
							>
						</fieldset>
						<label class="flex flex-col">
							Note (admins only)
							<input
								name="note"
								maxlength="2000"
								class="rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</label>
						<button
							type="submit"
							class="rounded-md bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900"
							>Resolve <span class="sr-only">the rescind of {rescind.itemTitle}</span></button
						>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	<h2 class="mt-10 text-lg font-semibold">Sellers flagged for overturned rescinds ({data.flags.length})</h2>
	{#if data.flags.length === 0}
		<p class="mt-3">No flagged sellers.</p>
	{:else}
		<ul class="mt-4 flex flex-col gap-2 text-sm">
			{#each data.flags as flag (flag.flagId)}
				<li class="flex flex-wrap items-center gap-3">
					<span>
						<a href="/admin/users?id={flag.userId}" class="underline">{who(flag.handle)}</a> · {flag.count} overturned
						· {fmt(flag.createdAt)}
					</span>
					<form method="POST" action="?/resolveFlag" use:enhance>
						<input type="hidden" name="flagId" value={flag.flagId} />
						<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1">Mark reviewed</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</section>
