<script lang="ts">
	import { untrack } from "svelte";
	import { formatRemaining } from "#lib/control-room.ts";

	/**
	 * A live countdown to a server deadline. `serverNow` is the server's clock when the
	 * page loaded, so a wrong device clock doesn't shift the time left.
	 */
	let {
		deadline,
		serverNow,
		label,
		endedLabel,
	}: { deadline: number; serverNow: number; label: string; endedLabel: string } = $props();

	// Captured once: the gap between the device clock and the server's when the page loaded.
	const offset = untrack(() => serverNow) - Date.now();
	let now = $state(untrack(() => serverNow));
	const left = $derived(deadline - now);

	const tick = () => {
		now = Date.now() + offset;
	};

	$effect(() => {
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	});
</script>

<span class="text-sm" data-testid="countdown">
	{#if left > 0}
		{label}
		<time datetime={new Date(deadline).toISOString()} class="font-semibold tabular-nums"
			>{formatRemaining(left)}</time
		>
	{:else}
		{endedLabel}
	{/if}
</span>
