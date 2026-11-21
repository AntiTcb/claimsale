<script lang="ts">
	import { trackingUrl } from "@claimsale/core";

	/** A shipped invoice's carrier and tracking number, linked to the carrier's tracking page. */
	interface Props {
		carrier: string;
		number: string;
	}

	let { carrier, number }: Props = $props();

	// @spec IO-tracking-link
	const url = $derived(trackingUrl(carrier, number));
</script>

{carrier}
{#if url}<a class="underline" href={url} target="_blank" rel="noopener noreferrer"
		>{number}<span class="sr-only"> (opens the {carrier} tracking page)</span></a
	>{:else}{number}{/if}
