<script lang="ts">
	import type { DigestEmailProps } from "../types.ts";
	import Layout from "./Layout.svelte";

	let { heading, lines, actionLabel, url, preferencesUrl }: DigestEmailProps = $props();
</script>

<Layout preheader={lines[0] ?? heading} {preferencesUrl}>
	<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">{heading}</h1>
	<ul style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:1.5">
		{#each lines as line, i (i)}
			<li>{line}</li>
		{/each}
	</ul>
	<a
		href={url}
		style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:15px"
		>{actionLabel}</a
	>
</Layout>
