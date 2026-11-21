<script lang="ts">
	import { enhance } from "$app/forms";
	import ControlRoomItem from "#lib/components/ControlRoomItem.svelte";
	import { buyerLabel, describeRecord, PHASE_LABELS, RESCIND_REASON_LABELS } from "#lib/control-room.ts";
	import type { PageProps } from "./$types";
	import { useDates } from "#lib/time-zone.svelte.ts";

	let { data, form }: PageProps = $props();
	const dates = useDates();
	const room = $derived(data.room);
	const fmt = (ms: number) => dates(ms);
	const open = $derived(room.rescinds.filter((r) => r.phase !== "final"));
</script>

<svelte:head>
	<title>Control room · {data.sale.title} · ClaimSale</title>
</svelte:head>

<section class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="text-2xl font-bold tracking-tight">Control room</h1>
	<p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
		Award, counter or decline, reorder backups and handle take-backs. Reload to see new claims.
	</p>
	{#if form?.message}
		<p
			role={form && "code" in form ? "alert" : "status"}
			class="mt-3 rounded-md p-3 {form && 'code' in form
				? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
				: 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200'}"
		>
			{form.message}
		</p>
	{/if}

	{#if room.takebacks.length > 0}
		<h2 class="mt-8 text-lg font-semibold">Take-back requests ({room.takebacks.length})</h2>
		<p class="text-sm text-zinc-600 dark:text-zinc-400">
			The claim stays won until you decide. Approving releases it and promotes the next in line.
		</p>
		<ul class="mt-3 flex flex-col gap-3">
			{#each room.takebacks as request (request.id)}
				{@const buyer = room.buyers[request.buyerId]}
				<li class="rounded-md border border-zinc-300 p-3 dark:border-zinc-700" data-testid="takeback">
					<p>
						<strong>{buyerLabel(buyer)}</strong> wants to give back <strong>{request.itemTitle}</strong>
						<span class="text-sm text-zinc-600 dark:text-zinc-400">· {fmt(request.createdAt)}</span>
					</p>
					{#if buyer}<p class="text-xs text-zinc-600 dark:text-zinc-400">
							{describeRecord(buyer.record)}
						</p>{/if}
					{#if request.reason}<p class="mt-1 text-sm">“{request.reason}”</p>{/if}
					<div class="mt-2 flex gap-2">
						<form method="POST" action="?/approveTakeback" use:enhance>
							<input type="hidden" name="requestId" value={request.id} />
							<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1 text-sm"
								>Approve <span class="sr-only">{buyerLabel(buyer)}'s take-back</span></button
							>
						</form>
						<form method="POST" action="?/denyTakeback" use:enhance>
							<input type="hidden" name="requestId" value={request.id} />
							<button type="submit" class="rounded-md border border-zinc-400 px-3 py-1 text-sm"
								>Deny <span class="sr-only">{buyerLabel(buyer)}'s take-back</span></button
							>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<h2 class="mt-8 text-lg font-semibold">Items</h2>
	{#if room.items.length === 0}
		<p class="mt-2">This sale has no items yet.</p>
	{:else}
		<div class="mt-3 flex flex-col gap-4">
			{#each room.items as item (item.id)}
				<ControlRoomItem {item} buyers={room.buyers} serverNow={data.now} {enhance} />
			{/each}
		</div>
	{/if}

	{#if room.rescinds.length > 0}
		<h2 class="mt-10 text-lg font-semibold">Rescinds</h2>
		{#if open.length > 0}
			<p class="text-sm text-zinc-600 dark:text-zinc-400">
				{open.length} still open: until they're final they count for no one.
			</p>
		{/if}
		<ul class="mt-3 flex flex-col gap-2 text-sm">
			{#each room.rescinds as rescind (rescind.id)}
				<li class="rounded-md border border-zinc-300 p-3 dark:border-zinc-700" data-testid="rescind">
					<p>
						<strong>{rescind.itemTitle}</strong> from {buyerLabel(room.buyers[rescind.buyerId])} ·
						{RESCIND_REASON_LABELS[rescind.reasonCode]}
					</p>
					<p class="text-zinc-600 dark:text-zinc-400">
						{PHASE_LABELS[rescind.phase]}{rescind.resolvedFault
							? ` · resolved as ${rescind.resolvedFault} fault`
							: ""}{rescind.refundOwed ? " · refund owed" : ""} · {fmt(rescind.createdAt)}
					</p>
				</li>
			{/each}
		</ul>
	{/if}
</section>
