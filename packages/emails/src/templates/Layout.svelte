<script lang="ts">
	import type { LayoutProps } from "../types.ts";

	let { preheader, preferencesUrl, children }: LayoutProps = $props();
</script>

<div style="display:none;max-height:0;overflow:hidden">{preheader}</div>
<table
	role="presentation"
	width="100%"
	cellpadding="0"
	cellspacing="0"
	style="background:#f4f4f5;padding:24px 0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"
>
	<tbody>
		<tr>
			<td align="center">
				<table
					role="presentation"
					width="100%"
					cellpadding="0"
					cellspacing="0"
					style="max-width:560px;background:#ffffff;border-radius:8px;padding:24px;color:#18181b"
				>
					<tbody>
						<tr>
							<td>
								<p style="margin:0 0 16px;font-weight:700;font-size:18px">ClaimSale</p>
								{@render children()}
							</td>
						</tr>
					</tbody>
				</table>
				<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#71717a">
					{#if preferencesUrl}
						You get this email because of your ClaimSale account.
						<a href={preferencesUrl} style="color:#71717a">Choose which emails you get</a>.
					{:else}
						You get this email because a seller added your address to a private sale on ClaimSale.
					{/if}
				</p>
			</td>
		</tr>
	</tbody>
</table>
