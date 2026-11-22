<script lang="ts">
	import { useDates } from "#lib/time-zone.svelte.ts";

	interface Item {
		readonly id: string;
		readonly title: string;
		readonly body: string;
		readonly read: boolean;
		readonly createdAt: number;
	}

	interface Props {
		notifications: readonly Item[];
	}

	let { notifications }: Props = $props();
	const dates = useDates();

	const when = (at: number) => dates(at, "short");
</script>

{#if notifications.length === 0}
	<p class="mt-6 text-zinc-600 dark:text-zinc-300">
		Nothing yet. Wins, offers, invoices and messages show up here.
	</p>
{:else}
	<ul class="mt-6 flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800" aria-label="Notifications">
		{#each notifications as item (item.id)}
			<li class="py-3" data-read={item.read}>
				<!-- Opening marks it read and goes to what it's about; works without JavaScript. -->
				<form method="POST" action="?/open">
					<input type="hidden" name="id" value={item.id} />
					<button type="submit" class="w-full text-left">
						<span class="flex items-start gap-2">
							{#if !item.read}
								<span class="mt-2 size-2 shrink-0 rounded-full bg-blue-700" aria-hidden="true"></span>
								<span class="sr-only">Unread:</span>
							{/if}
							<span class="min-w-0">
								<span class="block font-medium {item.read ? 'text-zinc-600 dark:text-zinc-400' : ''}"
									>{item.title}</span
								>
								<span class="block text-sm text-zinc-600 dark:text-zinc-300">{item.body}</span>
								<span class="block text-xs text-zinc-500 dark:text-zinc-400"
									><time datetime={new Date(item.createdAt).toISOString()}>{when(item.createdAt)}</time></span
								>
							</span>
						</span>
					</button>
				</form>
			</li>
		{/each}
	</ul>
{/if}
