<script lang="ts">
	import { REPORT_REASON_LABELS, REPORT_REASONS } from "@claimsale/core";
	import type { ThreadMessage } from "#lib/messaging/thread.ts";

	interface Props {
		messages: readonly ThreadMessage[];
		/** Show report forms on the other side's messages. */
		canReport?: boolean;
	}

	let { messages, canReport = true }: Props = $props();

	const when = (at: number) =>
		new Date(at).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
</script>

{#if messages.length === 0}
	<p class="text-zinc-600 dark:text-zinc-300">No messages yet.</p>
{:else}
	<ol class="flex flex-col gap-3" aria-label="Messages" aria-live="polite">
		{#each messages as message (message.id)}
			<li class="flex flex-col {message.mine ? 'items-end' : 'items-start'}" data-testid="message">
				<div
					class="max-w-[85%] rounded-lg px-3 py-2 {message.mine
						? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
						: 'bg-zinc-100 dark:bg-zinc-800'}"
				>
					<p class="text-xs opacity-75">
						{message.mine ? "You" : message.senderName} ·
						<time datetime={new Date(message.createdAt).toISOString()}>{when(message.createdAt)}</time>
					</p>
					{#if message.body}<p class="whitespace-pre-wrap break-words">{message.body}</p>{/if}
					{#each message.attachments as photo, i (photo.id)}
						<a href={photo.url} target="_blank" rel="noopener" class="mt-2 block">
							<img
								src={photo.url}
								alt="Photo {i + 1} from {message.mine ? 'you' : message.senderName}"
								width={photo.width ?? undefined}
								height={photo.height ?? undefined}
								loading="lazy"
								class="h-auto max-h-64 w-auto max-w-full rounded"
							/>
						</a>
					{/each}
				</div>
				{#if message.paymentWarning}
					<p
						role="note"
						class="mt-1 max-w-[85%] rounded border border-amber-400 bg-amber-50 px-2 py-1 text-sm text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-200"
					>
						Careful: this message mentions paying outside the invoice. Pay only the way the seller's invoice
						lists, never "friends and family", and report anyone who asks you to.
					</p>
				{/if}
				{#if canReport && !message.mine}
					<details class="mt-1 text-sm">
						<summary class="cursor-pointer text-zinc-600 underline dark:text-zinc-400"
							>Report<span class="sr-only"> this message from {message.senderName}</span></summary
						>
						<form method="POST" action="?/report" class="mt-2 flex flex-col gap-2">
							<input type="hidden" name="messageId" value={message.id} />
							<label class="flex flex-col gap-1">
								<span>Reason</span>
								<select
									name="reason"
									required
									class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
								>
									{#each REPORT_REASONS as reason (reason)}
										<option value={reason}>{REPORT_REASON_LABELS[reason]}</option>
									{/each}
								</select>
							</label>
							<label class="flex flex-col gap-1">
								<span>Details (optional)</span>
								<textarea
									name="details"
									rows="2"
									maxlength="1000"
									class="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
								></textarea>
							</label>
							<button type="submit" class="self-start rounded border border-zinc-400 px-2 py-1"
								>Send report</button
							>
						</form>
					</details>
				{/if}
			</li>
		{/each}
	</ol>
{/if}
