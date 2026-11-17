<script lang="ts">
	import type { InviteEmailProps } from "../types.ts";
	import Layout from "./Layout.svelte";

	let { saleTitle, sellerName, when, url }: InviteEmailProps = $props();
</script>

<Layout preheader="{sellerName} invited you to a private sale" preferencesUrl={null}>
	<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">You're invited to “{saleTitle}”</h1>
	<p style="margin:0 0 12px;font-size:15px;line-height:1.5">
		{sellerName} added this email address to the invite list of a private claim sale{when
			? `, which goes live ${when}`
			: ""}.
	</p>
	<p style="margin:0 0 20px;font-size:15px;line-height:1.5">
		Sign in or create an account with this email address and confirm it to see the sale.
	</p>
	<a
		href={url}
		style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:15px"
		>Open the sale</a
	>
</Layout>
