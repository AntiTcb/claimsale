<script lang="ts">
	import type { NotificationEmailProps } from "../types.ts";
	import Layout from "./Layout.svelte";

	let { title, body, actionLabel, url, preferencesUrl }: NotificationEmailProps = $props();
</script>

<Layout preheader={body} {preferencesUrl}>
	<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">{title}</h1>
	<p style="margin:0 0 20px;font-size:15px;line-height:1.5">{body}</p>
	<a
		href={url}
		style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:15px"
		>{actionLabel}</a
	>
</Layout>
