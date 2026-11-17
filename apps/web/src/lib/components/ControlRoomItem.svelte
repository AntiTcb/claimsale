<script lang="ts">
	import { formatCents, MIN_RESCIND_EXPLANATION } from "@claimsale/core";
	import type { Action } from "svelte/action";
	import Countdown from "./Countdown.svelte";
	import {
		buyerLabel,
		describeRecord,
		RESCIND_REASON_OPTIONS,
		type BuyerSummary,
		type ControlItem,
		type QueueEntry,
	} from "#lib/control-room.ts";

	/**
	 * One item in the seller's control room: its winners, its ranked queue of claims and
	 * offers, countered offers, and the forms that act on them. The forms post to the
	 * page's actions; the page passes SvelteKit's `enhance`.
	 */
	let {
		item,
		buyers,
		serverNow,
		enhance = () => {},
	}: {
		item: ControlItem;
		buyers: Readonly<Record<string, BuyerSummary>>;
		serverNow: number;
		enhance?: Action<HTMLFormElement>;
	} = $props();

	const freeUnits = $derived(Math.max(0, item.quantity - item.winners.length));
	const who = (entry: QueueEntry) => buyerLabel(buyers[entry.buyerId]);
	const record = (entry: QueueEntry) => {
		const buyer = buyers[entry.buyerId];
		return buyer ? describeRecord(buyer.record) : "";
	};
	const paid = (entry: QueueEntry) => entry.invoiceStatus === "buyer_paid" || entry.invoiceStatus === "paid";
	const kindLabel = (entry: QueueEntry) => (entry.kind === "claim" ? "Claim" : "Offer");
	const STATE_LABELS: Record<string, string> = {
		available: "Available",
		deciding: "Deciding",
		sold_out: "Sold out",
		withdrawn: "Withdrawn",
		unsold: "Unsold",
	};
	const button = "rounded-md border border-zinc-400 px-2 py-1 text-sm dark:border-zinc-600";
	const field = "rounded-md border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900";
</script>

<article
	class="rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
	aria-labelledby="item-{item.id}"
	data-testid="control-item"
>
	<header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
		<h2 id="item-{item.id}" class="text-lg font-semibold">{item.title}</h2>
		<span>{formatCents(item.priceCents)}</span>
		<span class="text-sm text-zinc-600 dark:text-zinc-400"
			>{item.winners.length} of {item.quantity} taken</span
		>
		<span class="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium dark:bg-zinc-800"
			>{STATE_LABELS[item.state] ?? item.state}</span
		>
	</header>
	{#if item.decisionDeadline !== null}
		<p class="mt-1 text-amber-900 dark:text-amber-200">
			<Countdown
				deadline={item.decisionDeadline}
				{serverNow}
				label="Decide within"
				endedLabel="The window has ended; the earliest claim wins next."
			/>
		</p>
	{/if}
	{#if item.offersLapseAt !== null}
		<p class="mt-1">
			<Countdown
				deadline={item.offersLapseAt}
				{serverNow}
				label="Open offers lapse in"
				endedLabel="Open offers have lapsed."
			/>
		</p>
	{/if}

	<h3 class="mt-4 text-sm font-semibold">Winners</h3>
	{#if item.winners.length === 0}
		<p class="text-sm text-zinc-600 dark:text-zinc-400">No winner yet.</p>
	{:else}
		<ul class="mt-1 flex flex-col gap-2">
			{#each item.winners as entry (entry.id)}
				<li class="rounded bg-zinc-50 p-2 dark:bg-zinc-900" data-testid="winner">
					<p>
						<strong>{who(entry)}</strong> · {kindLabel(entry)} at {formatCents(entry.amountCents)}
						{#if entry.invoiceStatus}<span class="text-sm">
								· invoice {entry.invoiceStatus.replace("_", " ")}</span
							>{/if}
					</p>
					<p class="text-xs text-zinc-600 dark:text-zinc-400">{record(entry)}</p>
					<details class="mt-2">
						<summary class="cursor-pointer text-sm underline">Rescind {who(entry)}'s win</summary>
						<form method="POST" action="?/rescind" use:enhance class="mt-2 flex flex-col gap-2">
							<input type="hidden" name="itemId" value={item.id} />
							<input type="hidden" name="entryId" value={entry.id} />
							<label class="flex flex-col gap-1 text-sm">
								Reason
								<select name="reasonCode" required class={field}>
									<option value="">Choose a reason</option>
									{#each RESCIND_REASON_OPTIONS as option (option.code)}
										<option value={option.code}>{option.label} ({option.note})</option>
									{/each}
								</select>
							</label>
							<label class="flex flex-col gap-1 text-sm">
								What happened (the buyer sees this)
								<textarea
									name="explanation"
									rows="3"
									required
									minlength={MIN_RESCIND_EXPLANATION}
									maxlength="2000"
									class={field}></textarea>
							</label>
							<label class="flex items-center gap-2 text-sm">
								<input type="checkbox" name="passToNext" checked /> Pass it to the next in line
							</label>
							{#if paid(entry)}
								<label class="flex items-center gap-2 text-sm text-amber-900 dark:text-amber-200">
									<input type="checkbox" name="confirmed" /> The buyer marked this invoice paid. I understand a
									refund is owed unless the payment was reversed.
								</label>
							{/if}
							<button type="submit" class="self-start rounded-md bg-red-700 px-3 py-1 text-sm text-white"
								>Rescind</button
							>
						</form>
					</details>
				</li>
			{/each}
		</ul>
	{/if}

	<h3 class="mt-4 text-sm font-semibold">Queue ({item.queue.length})</h3>
	{#if item.queue.length === 0}
		<p class="text-sm text-zinc-600 dark:text-zinc-400">No open claims or offers.</p>
	{:else}
		<ol class="mt-1 flex flex-col gap-2">
			{#each item.queue as entry, i (entry.id)}
				<li class="rounded bg-zinc-50 p-2 dark:bg-zinc-900" data-testid="queue-entry">
					<p>
						<span class="font-mono text-sm">#{i + 1}</span>
						<strong>{who(entry)}</strong> · {kindLabel(entry)}
						{formatCents(entry.amountCents)}
						{#if entry.counterCents !== null}<span class="text-sm">
								· accepted counter {formatCents(entry.counterCents)}</span
							>{/if}
					</p>
					<p class="text-xs text-zinc-600 dark:text-zinc-400">{record(entry)}</p>
					<div class="mt-2 flex flex-wrap items-start gap-2">
						{#if freeUnits > 0}
							<form method="POST" action="?/award" use:enhance>
								<input type="hidden" name="itemId" value={item.id} />
								<input type="hidden" name="entryId" value={entry.id} />
								<button
									type="submit"
									class="rounded-md bg-zinc-900 px-2 py-1 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
									>Award <span class="sr-only">{who(entry)}</span></button
								>
							</form>
						{/if}
						{#if entry.kind === "offer"}
							<form method="POST" action="?/decline" use:enhance>
								<input type="hidden" name="itemId" value={item.id} />
								<input type="hidden" name="entryId" value={entry.id} />
								<button type="submit" class={button}
									>Decline <span class="sr-only">{who(entry)}'s offer</span></button
								>
							</form>
							{#if entry.counterCents === null}
								<details>
									<summary class="cursor-pointer text-sm underline"
										>Counter <span class="sr-only">{who(entry)}'s offer</span></summary
									>
									<form method="POST" action="?/counter" use:enhance class="mt-1 flex items-end gap-2">
										<input type="hidden" name="itemId" value={item.id} />
										<input type="hidden" name="entryId" value={entry.id} />
										<label class="flex flex-col text-sm"
											>Counter amount ($)
											<input name="amount" inputmode="decimal" required class="w-28 {field}" /></label
										>
										<button type="submit" class={button}>Send counter</button>
									</form>
								</details>
							{/if}
						{/if}
						{#if item.queue.length > 1}
							<form method="POST" action="?/moveBackup" use:enhance>
								<input type="hidden" name="itemId" value={item.id} />
								<input type="hidden" name="entryId" value={entry.id} />
								<input type="hidden" name="direction" value="up" />
								<button type="submit" class={button} disabled={i === 0}
									><span aria-hidden="true">↑</span><span class="sr-only">Move {who(entry)} up</span></button
								>
							</form>
							<form method="POST" action="?/moveBackup" use:enhance>
								<input type="hidden" name="itemId" value={item.id} />
								<input type="hidden" name="entryId" value={entry.id} />
								<input type="hidden" name="direction" value="down" />
								<button type="submit" class={button} disabled={i === item.queue.length - 1}
									><span aria-hidden="true">↓</span><span class="sr-only">Move {who(entry)} down</span
									></button
								>
							</form>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}

	{#if item.countered.length > 0}
		<h3 class="mt-4 text-sm font-semibold">Countered</h3>
		<ul class="mt-1 flex flex-col gap-1 text-sm">
			{#each item.countered as entry (entry.id)}
				<li data-testid="countered-entry">
					<strong>{who(entry)}</strong> offered {formatCents(entry.amountCents)}; you countered
					{formatCents(entry.counterCents ?? 0)}.
					{#if entry.counterExpiresAt !== null}
						<Countdown
							deadline={entry.counterExpiresAt}
							{serverNow}
							label="Expires in"
							endedLabel="The counter has expired."
						/>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if item.state !== "withdrawn" && item.state !== "unsold"}
		<details class="mt-4">
			<summary class="cursor-pointer text-sm underline">Withdraw {item.title}</summary>
			<form method="POST" action="?/withdrawItem" use:enhance class="mt-2 flex flex-col gap-2 text-sm">
				<input type="hidden" name="itemId" value={item.id} />
				<p>Open claims and offers end. Winners stay; rescind them one by one if you need to.</p>
				<button type="submit" class="self-start rounded-md bg-red-700 px-3 py-1 text-white"
					>Withdraw item</button
				>
			</form>
		</details>
	{/if}
</article>
