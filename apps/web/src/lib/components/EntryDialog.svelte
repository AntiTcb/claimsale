<script lang="ts">
	import { formatCents } from "@claimsale/core";
	import { parseDollars } from "#lib/live/state.ts";

	/**
	 * Confirms a claim ("Claims are binding. Claim for $40?", PLAN §3) or takes an offer's
	 * amount. A modal <dialog>: focus moves into it and Escape cancels.
	 */
	interface Props {
		/** What's being confirmed; null closes the dialog. */
		request: { kind: "claim" | "offer"; title: string; priceCents: number } | null;
		onconfirm: (amountCents?: number) => void;
		oncancel: () => void;
	}

	let { request, onconfirm, oncancel }: Props = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let amount = $state("");
	let error = $state("");

	$effect(() => {
		if (!dialog) return;
		if (request && !dialog.open) {
			amount = "";
			error = "";
			dialog.showModal();
		} else if (!request && dialog.open) {
			dialog.close();
		}
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!request) return;
		if (request.kind === "claim") {
			onconfirm();
			return;
		}
		const cents = parseDollars(amount);
		if (cents === undefined) {
			error = "Enter an amount in dollars, like 35 or 35.50";
			return;
		}
		onconfirm(cents);
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="entry-dialog-title"
	class="m-auto max-w-sm rounded-lg p-0 backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100"
	oncancel={(event) => {
		event.preventDefault();
		oncancel();
	}}
>
	{#if request}
		<form class="flex flex-col gap-3 p-5" onsubmit={submit}>
			{#if request.kind === "claim"}
				<h2 id="entry-dialog-title" class="text-lg font-semibold">Claim {request.title}?</h2>
				<p>Claims are binding. Claim for {formatCents(request.priceCents)}?</p>
			{:else}
				<h2 id="entry-dialog-title" class="text-lg font-semibold">Make an offer on {request.title}</h2>
				<p class="text-sm">
					Asking {formatCents(request.priceCents)}. Offers are binding: if the seller accepts, you owe it.
				</p>
				<label class="flex flex-col gap-1">
					<span class="text-sm font-medium">Your offer ($)</span>
					<input
						name="amount"
						inputmode="decimal"
						autocomplete="off"
						required
						bind:value={amount}
						aria-invalid={error ? "true" : undefined}
						aria-describedby={error ? "entry-dialog-error" : undefined}
						class="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-950"
					/>
				</label>
				{#if error}<p id="entry-dialog-error" class="text-sm text-red-700 dark:text-red-400">{error}</p>{/if}
			{/if}
			<div class="flex justify-end gap-2">
				<button type="button" class="rounded-md px-3 py-1.5" onclick={() => oncancel()}>Cancel</button>
				<button
					type="submit"
					class="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
					>{request.kind === "claim" ? `Claim for ${formatCents(request.priceCents)}` : "Send offer"}</button
				>
			</div>
		</form>
	{/if}
</dialog>
